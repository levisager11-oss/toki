import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript file (a Cloudflare Worker)
import worker from "../cloudflare/games-worker/worker.js";

type Stored = { body: Uint8Array; etag: string };

/** A tiny R2 bucket: counts reads, understands onlyIf (If-None-Match) and returns whole files. */
function fakeBucket(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    async get(key: string, opts?: { onlyIf?: Headers }) {
      reads.push(key);
      const data = files[key];
      if (data === undefined) return null;
      const bytes = new TextEncoder().encode(data);
      const etag = `"${key.length}-${bytes.length}"`;
      if (opts?.onlyIf?.get("if-none-match") === etag) return { size: bytes.length, httpEtag: etag };
      return { body: new Response(bytes).body, size: bytes.length, httpEtag: etag, json: async () => JSON.parse(data) };
    },
    async head(key: string) {
      return key in files ? { size: 1 } : null;
    },
  };
}

/** A tiny edge cache keyed by URL. */
function fakeCache() {
  const store = new Map<string, Stored>();
  return {
    store,
    async match(req: Request) {
      const s = store.get(req.url);
      if (!s) return undefined;
      return new Response(s.body, { headers: { "content-length": String(s.body.length), "x-toki-etag": s.etag } });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, { body: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get("x-toki-etag") ?? "" });
    },
  };
}

const sites = { "sites/snake.json": JSON.stringify({ build: "b1", entry: "index.html" }) };
const env = (bucket: unknown) => ({ BUCKET: bucket, DOMAIN: "playtoki.app", RESERVED: "www" });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://snake.playtoki.app${path}`, { headers });

function run(bucket: ReturnType<typeof fakeBucket>) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  return {
    fetch: async (req: Request) => {
      const res = await worker.fetch(req, env(bucket), ctx);
      await res.clone().arrayBuffer().catch(() => {});
      await Promise.all(pending);
      return res as Response;
    },
  };
}

describe("games Worker cache", () => {
  const original = (globalThis as { caches?: unknown }).caches;
  let cache: ReturnType<typeof fakeCache>;
  beforeEach(() => {
    cache = fakeCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });
  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  it("reads a file from R2 once, then from the cache", async () => {
    const bucket = fakeBucket({ ...sites, "b/b1/game.js": "console.log(1)" });
    const w = run(bucket);
    const first = await w.fetch(get("/game.js"));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("console.log(1)");
    expect(cache.store.size).toBe(1);

    bucket.reads.length = 0;
    const second = await w.fetch(get("/game.js"));
    expect(await second.text()).toBe("console.log(1)");
    expect(second.headers.get("content-type")).toContain("javascript");
    expect(bucket.reads.filter((k) => k.startsWith("b/"))).toEqual([]);
  });

  it("answers 304 from the cache when the browser already has the file", async () => {
    const bucket = fakeBucket({ ...sites, "b/b1/game.js": "x" });
    const w = run(bucket);
    const first = await w.fetch(get("/game.js"));
    const etag = first.headers.get("etag")!;
    bucket.reads.length = 0;
    const again = await w.fetch(get("/game.js", { "if-none-match": etag }));
    expect(again.status).toBe(304);
    expect(bucket.reads.filter((k) => k.startsWith("b/"))).toEqual([]);
  });

  it("keys each copy by build, so a new version never shows old files", async () => {
    const bucket = fakeBucket({ ...sites, "b/b1/game.js": "old" });
    await run(bucket).fetch(get("/game.js"));
    const keys = [...cache.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("/__build/b1/game.js");
  });

  it("does not cache range requests or missing files", async () => {
    const bucket = fakeBucket({ ...sites, "b/b1/game.js": "abcdef" });
    const w = run(bucket);
    await w.fetch(get("/game.js", { range: "bytes=0-2" }));
    expect(cache.store.size).toBe(0);
    const missing = await w.fetch(get("/nope.js"));
    expect(missing.status).toBe(404);
    expect(cache.store.size).toBe(0);
  });

  it("still works when there is no cache", async () => {
    (globalThis as { caches?: unknown }).caches = undefined;
    const bucket = fakeBucket({ ...sites, "b/b1/game.js": "plain" });
    const res = await run(bucket).fetch(get("/game.js"));
    expect(await res.text()).toBe("plain");
  });
});
