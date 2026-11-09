import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deployCommit, filesIn, gamesForPush, readTar, validSignature } from "../server/gitDeploy";
import type { Db } from "../server/db";
import type { GitHubClient } from "../server/github";
import type { Deps } from "../server/hosting";

/** A tar the way GitHub makes them: a global pax header, one top folder, pax for long names. */
function tar(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write("0000644\0", 100);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const add = (name: string, body: Buffer, type: string) => {
    blocks.push(header(name, body.length, type), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  add("pax_global_header", Buffer.from("52 comment=0123456789012345678901234567890123456789\n"), "g");
  for (const [name, text] of Object.entries(files)) {
    const full = `lu-moon-hop-0123456/${name}`;
    if (full.length > 100) {
      const rec = `path=${full}\n`;
      let len = rec.length + 3;
      len = rec.length + String(len).length + 1;
      add("PaxHeader", Buffer.from(`${len} ${rec}`), "x");
    }
    add(full.slice(0, 100), Buffer.from(text), "0");
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("reading a repository", () => {
  const long = `${"deep/".repeat(25)}x.js`;
  const files = readTar(tar({ "index.html": "<html>", "build/index.html": "<b>", [long]: "1", "README.md": "#" }));

  it("reads GitHub's tarballs, long names included", () => {
    expect(files.map((f) => f.path)).toEqual([
      "lu-moon-hop-0123456/index.html", "lu-moon-hop-0123456/build/index.html", `lu-moon-hop-0123456/${long}`, "lu-moon-hop-0123456/README.md",
    ]);
    expect(new TextDecoder().decode(files[0].data)).toBe("<html>");
  });

  it("takes only the chosen folder", () => {
    expect(filesIn(files, "build").map((f) => f.path)).toEqual(["index.html"]);
    expect(filesIn(files, "/build/").map((f) => f.path)).toEqual(["index.html"]);
    expect(filesIn(files, "").length).toBe(4);
  });
});

describe("GitHub's push events", () => {
  it("only trusts events signed with the webhook secret", () => {
    const sig = `sha256=${createHmac("sha256", "s3cret").update("{}").digest("hex")}`;
    expect(validSignature("s3cret", "{}", sig)).toBe(true);
    expect(validSignature("other", "{}", sig)).toBe(false);
    expect(validSignature("", "{}", sig)).toBe(false);
    expect(validSignature("s3cret", "{}", null)).toBe(false);
  });

  const db = (rows: Record<string, unknown>[]) => ({ select: async () => rows }) as unknown as Db;
  const row = { game_id: "g", installation_id: 7, repo: "lu/moon-hop", branch: "main", folder: "", created_by: "dev" };
  const SHA = "a".repeat(40);

  it("finds the games that follow the pushed branch", async () => {
    const hit = await gamesForPush(db([row]), { ref: "refs/heads/main", after: SHA, repository: { full_name: "lu/moon-hop" }, installation: { id: 7 }, head_commit: { message: "Faster\n\nmore" } });
    expect(hit).toEqual({ rows: [row], commit: { sha: SHA, message: "Faster" } });
  });

  it("ignores tags, deleted branches and other installations", async () => {
    expect(await gamesForPush(db([row]), { ref: "refs/tags/v1", after: SHA, repository: { full_name: "lu/moon-hop" }, installation: { id: 7 } })).toBeNull();
    expect(await gamesForPush(db([row]), { ref: "refs/heads/main", after: "0".repeat(40), deleted: true, repository: { full_name: "lu/moon-hop" }, installation: { id: 7 } })).toBeNull();
    expect(await gamesForPush(db([row]), { ref: "refs/heads/main", after: SHA, repository: { full_name: "lu/moon-hop" }, installation: { id: 8 } })).toBeNull();
  });
});

describe("deploying a commit", () => {
  it("puts the folder live and records how it went", async () => {
    const updates: Record<string, unknown>[] = [];
    const games = [{ id: "11111111-1111-4111-8111-111111111111", slug: "moon-hop", title: "Moon Hop", created_by: "dev", hosted_site: "moon-hop", needs_isolation: false, thumbnail_url: null, screenshots: [], old_slugs: [] }];
    const builds: Record<string, unknown>[] = [];
    const objects = new Map<string, number>();
    const pointers = new Map<string, string>();
    const fakeDb = {
      select: async (table: string) => (table === "games" ? games : table === "profiles" ? [{ id: "dev", role: "creator" }] : table === "game_builds" ? builds.filter((b) => b.status === "uploading") : []),
      insert: async (table: string, r: Record<string, unknown>) => {
        const out = { id: "22222222-2222-4222-8222-222222222222", ...r };
        if (table === "game_builds") builds.push(out);
        return [out];
      },
      update: async (table: string, _q: string, patch: Record<string, unknown>) => {
        if (table === "game_git") updates.push(patch);
        if (table === "game_builds") for (const b of builds) Object.assign(b, patch);
        return [];
      },
      remove: async () => null,
      rpc: async () => null,
    } as unknown as Db;
    const deps: Deps = {
      db: fakeDb,
      config: { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "games", domain: "playtoki.app" },
      store: {
        uploadUrl: (key: string) => `https://r2.test/${key}`,
        put: async (k: string, v: string) => void pointers.set(k, v),
        getText: async () => "",
        copy: async () => {},
        remove: async () => {},
        list: async (prefix: string) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })),
        removeMany: async () => {},
      },
    };
    const tarball = gzipSync(tar({ "toki.json": JSON.stringify({ folder: "build" }), "build/index.html": "<html>", "build/game.js": "go()", "src/main.ts": "x" }));
    const gh = { repo: async () => ({ tarball: async () => tarball, head: async () => ({ sha: "b".repeat(40), message: "x" }) }) } as unknown as GitHubClient;
    const put = (async (url: string, init: RequestInit) => {
      objects.set(new URL(url).pathname.slice(1), (init.body as Uint8Array).length);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const out = await deployCommit(deps, gh, { game_id: games[0].id, installation_id: 7, repo: "lu/moon-hop", branch: "main", folder: "", created_by: "dev" }, { sha: "c".repeat(40), message: "Faster" }, put);
    expect(out).toEqual({ ok: true, play_url: "https://moon-hop.playtoki.app/" });
    expect([...objects.keys()].sort()).toEqual(["b/22222222-2222-4222-8222-222222222222/game.js", "b/22222222-2222-4222-8222-222222222222/index.html"]);
    expect(updates[0]).toMatchObject({ status: "deploying", last_sha: "c".repeat(40), last_message: "Faster" });
    expect(updates.at(-1)).toMatchObject({ status: "live", error: null });
  });
});
