// "Move to Toki": downloading a game from where it runs, moving it, and bringing players'
// progress over from its old address.
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { checkMove, crawlGame, findRepoBuild, moveBack, moveGame, pagesRepos, references, savesVerdict, type CrawledFile } from "../server/migrate";
import type { GitHubClient } from "../server/github";
import { HostingError, type Deps } from "../server/hosting";
import { fakeDb, fakeStore, tar, type Row } from "./fakes";
import { HELLO_MS, keepPickedUp, listenForPickup, needsPickup, STORE_MS } from "../src/lib/movedSaves";
import { readRecord, type KeyValue } from "../src/lib/saves";

interface Page {
  body: string | Uint8Array;
  type?: string;
  status?: number;
  location?: string;
  encoding?: string;
}

/** A pretend web: answers like fetch does (unpacked bodies, with the server's headers). */
function web(pages: Record<string, Page>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const p = pages[url];
    if (!p) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "content-type": p.type ?? "text/html" });
    if (p.location) headers.set("location", p.location);
    if (p.encoding) headers.set("content-encoding", p.encoding);
    return new Response(p.status && p.status >= 300 && p.status < 400 ? null : (p.body as BodyInit), { status: p.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}
const publicDns = async () => ["185.199.108.153"];

const ROOT = "https://lu.github.io/moon-hop/";
const SITE: Record<string, Page> = {
  "https://lu.github.io/moon-hop": { body: "", status: 301, location: ROOT },
  [ROOT]: {
    body: `<!doctype html><html><head>
      <script src="https://playtoki.app/toki-save.js"></script>
      <link rel="stylesheet" href="css/style.css?v=2">
      <script src="https://cdn.example.com/phaser.min.js"></script>
      <script type="module" src="./js/main.js"></script>
      <script>var GODOT_CONFIG = {"executable":"engine/moon","args":[]};</script>
    </head><body><img src="img/logo.png" srcset="img/logo.png 1x, img/logo@2x.png 2x"><a href="../other-game/">More</a></body></html>`,
  },
  [`${ROOT}css/style.css`]: { body: "body{background:url('../img/bg.png')} @import 'fonts.css';", type: "text/css" },
  [`${ROOT}css/fonts.css`]: { body: "@font-face{src:url(pixel.woff2)}", type: "text/css" },
  [`${ROOT}css/pixel.woff2`]: { body: "w2", type: "font/woff2" },
  [`${ROOT}img/bg.png`]: { body: "png", type: "image/png" },
  [`${ROOT}img/logo.png`]: { body: "png", type: "image/png" },
  [`${ROOT}img/logo@2x.png`]: { body: "png", type: "image/png" },
  [`${ROOT}js/main.js`]: {
    body: `import { level } from "./level.js"; const buildUrl = "Build"; load(buildUrl + "/web.wasm.br"); fetch("assets/hero.png"); fetch("/secret.json");`,
    type: "text/javascript",
  },
  [`${ROOT}js/level.js`]: { body: "export const level = 1;", type: "text/javascript" },
  [`${ROOT}assets/hero.png`]: { body: "hero", type: "image/png" },
  [`${ROOT}Build/web.wasm.br`]: { body: "wasm bytes", type: "application/wasm", encoding: "br" },
  [`${ROOT}engine/moon.js`]: { body: "godot", type: "text/javascript" },
  [`${ROOT}engine/moon.wasm`]: { body: "w", type: "application/wasm" },
  // The game keeps a copy of its progress where Toki's save script sees it (integration.ts).
  [`${ROOT}engine/moon.pck`]: { body: 'GDPC...JavaScriptBridge.eval("localStorage.setItem(\'save\', s)")', type: "application/octet-stream" },
  [`${ROOT}toki.json`]: { body: JSON.stringify({ controls: "Space to hop" }), type: "application/json" },
  "https://lu.github.io/other-game/": { body: "<html>other</html>" },
  "https://lu.github.io/secret.json": { body: "{}" },
};

describe("downloading a game from where it runs", () => {
  it("takes the page and everything it points to inside the game's folder", async () => {
    const { fetchImpl, asked } = web(SITE);
    const got = await crawlGame("https://lu.github.io/moon-hop?utm=x#top", { fetch: fetchImpl, resolve: publicDns });
    expect(got.start).toBe(ROOT);
    expect(got.entry).toBe("index.html");
    expect(got.files.map((f) => f.path).sort()).toEqual([
      "Build/web.wasm.br", "assets/hero.png", "css/fonts.css", "css/pixel.woff2", "css/style.css", "engine/moon.js", "engine/moon.pck", "engine/moon.wasm",
      "img/bg.png", "img/logo.png", "img/logo@2x.png", "index.html", "js/level.js", "js/main.js", "toki.json",
    ]);
    expect(got.toki).toEqual({ controls: "Space to hop" });
    expect(got.saveScript).toBe(true);
    // Other sites and other parts of the same site stay where they are.
    expect(asked.filter((u) => !u.startsWith(ROOT) && u !== "https://lu.github.io/moon-hop")).toEqual([]);
  });

  it("keeps files packed that say so in their name", async () => {
    const { fetchImpl } = web(SITE);
    const got = await crawlGame(ROOT, { fetch: fetchImpl, resolve: publicDns });
    const wasm = got.files.find((f) => f.path === "Build/web.wasm.br")!;
    expect(Buffer.from(wasm.data)).toEqual(Buffer.from(brotliCompressSync(Buffer.from("wasm bytes"))));
  });

  it("starts at the page in the link when it isn't index.html", async () => {
    const { fetchImpl } = web({ "https://example.com/games/play.html": { body: '<script src="game.js"></script>' }, "https://example.com/games/game.js": { body: "1", type: "text/javascript" } });
    const got = await crawlGame("https://example.com/games/play.html", { fetch: fetchImpl, resolve: publicDns });
    expect(got.entry).toBe("play.html");
    expect(got.files.map((f) => f.path).sort()).toEqual(["game.js", "play.html"]);
    expect(got.saveScript).toBe(false);
  });

  it("never reads local or private addresses", async () => {
    const { fetchImpl, asked } = web(SITE);
    await expect(crawlGame(ROOT, { fetch: fetchImpl, resolve: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "move_unreachable" });
    await expect(crawlGame("http://lu.github.io/moon-hop/", { fetch: fetchImpl, resolve: publicDns })).rejects.toMatchObject({ code: "move_unreachable" });
    expect(asked).toEqual([]);
  });

  it("stops at Toki's size limit", async () => {
    const big = new Uint8Array(101 * 1024 * 1024);
    const { fetchImpl } = web({ [ROOT]: { body: '<script src="big.js"></script>' }, [`${ROOT}big.js`]: { body: big, type: "text/javascript" } });
    await expect(crawlGame(ROOT, { fetch: fetchImpl, resolve: publicDns })).rejects.toMatchObject({ code: "too_big" });
  });

  it("finds file names in pages, styles and scripts", () => {
    expect(references(`<img srcset="a.png 1x, b.png 2x"><div style="background:url(c.png)">`, "index.html")).toEqual(expect.arrayContaining(["a.png", "b.png", "c.png"]));
    expect(references("loadImage('sprites/ship.webp'); x = `${base}/y.png`; data:image/png", "game.js")).toEqual(["sprites/ship.webp"]);
  });
});

describe("moving a game", () => {
  const GAME = "11111111-1111-4111-8111-111111111111";
  const DEV = { id: "dev", role: "creator" as const };
  let tables: Record<string, Row[]>;
  let deps: Deps;
  let puts: string[];
  const put = (async (url: string) => {
    puts.push(url);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    tables = {
      games: [{ id: GAME, slug: "moon-hop", title: "Moon Hop", created_by: "dev", hosted_site: null, needs_isolation: false, thumbnail_url: null, screenshots: [], old_slugs: [], play_url: ROOT }],
      game_builds: [],
      game_releases: [],
      game_saves: [],
      profiles: [{ id: "dev", role: "creator" }],
    };
    puts = [];
    const files = new Map<string, number>();
    const store = fakeStore(files, new Map());
    // The pretend Cloudflare gets each file from its upload link.
    const realPut = put;
    deps = { db: fakeDb(tables), store, config: { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "games", domain: "playtoki.app" }, now: () => new Date("2026-11-19T10:00:00Z") };
    puts = [];
    (deps as Deps & { put: typeof fetch }).put = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      files.set(decodeURIComponent(u.pathname.slice(1)), Number(u.searchParams.get("size")));
      return realPut(url, init);
    }) as unknown as typeof fetch;
  });
  const opts = () => ({ fetch: web(SITE).fetchImpl, resolve: publicDns, put: (deps as Deps & { put: typeof fetch }).put });

  it("puts the game live on Toki and remembers its old address for players' progress", async () => {
    const out = await moveGame(deps, DEV, GAME, false, opts());
    expect(out).toMatchObject({ play_url: "https://moon-hop.playtoki.app/", from: ROOT, files: 15, saves: true });
    expect(puts).toHaveLength(15);
    expect(tables.games[0]).toMatchObject({ play_url: "https://moon-hop.playtoki.app/", hosted_site: "moon-hop", moved_from: ROOT, moved_at: "2026-11-19T10:00:00.000Z", controls: "Space to hop" });
    await expect(moveGame(deps, DEV, GAME, false, opts())).rejects.toMatchObject({ code: "already_hosted" });
  });

  it("doesn't move a game whose saves would stay behind, unless told to", async () => {
    const page = SITE[ROOT].body as string;
    const site = { ...SITE, [ROOT]: { body: page.replace('<script src="https://playtoki.app/toki-save.js"></script>', "") } };
    const o = { ...opts(), fetch: web(site).fetchImpl };
    await expect(moveGame(deps, DEV, GAME, false, o)).rejects.toMatchObject({ code: "move_no_saves" });
    expect(puts).toEqual([]);
    expect(tables.games[0].play_url).toBe(ROOT);
    // Saves Toki already keeps for the game also count.
    tables.game_saves.push({ game_id: GAME, user_id: "p1" });
    expect((await moveGame(deps, DEV, GAME, false, o)).saves).toBe(true);
  });

  it("moves anyway when the developer accepts that progress stays behind", async () => {
    const page = SITE[ROOT].body as string;
    const site = { ...SITE, [ROOT]: { body: page.replace("toki-save.js", "other.js") } };
    const out = await moveGame(deps, DEV, GAME, true, { ...opts(), fetch: web(site).fetchImpl });
    expect(out.saves).toBe(false);
    expect(tables.games[0].play_url).toBe("https://moon-hop.playtoki.app/");
  });

  it("only moves the developer's own games", async () => {
    await expect(moveGame(deps, { id: "other", role: "creator" }, GAME, false, opts())).rejects.toBeInstanceOf(HostingError);
  });

  it("goes back to the old link", async () => {
    await moveGame(deps, DEV, GAME, false, opts());
    expect(await moveBack(deps, DEV, GAME)).toEqual({ play_url: ROOT });
    expect(tables.games[0]).toMatchObject({ play_url: ROOT, moved_from: null, moved_at: null });
    expect(tables.game_builds.every((b) => b.status === "deleting")).toBe(true);
    await expect(moveBack(deps, DEV, GAME)).rejects.toMatchObject({ code: "not_moved" });
  });

  it("warns when a Godot game doesn't keep a copy of its progress for the save script", async () => {
    const site = { ...SITE, [`${ROOT}engine/moon.pck`]: { body: "GDPC user://save.dat" } };
    await expect(moveGame(deps, DEV, GAME, false, { ...opts(), fetch: web(site).fetchImpl })).rejects.toMatchObject({ code: "move_engine_saves" });
    expect(tables.games[0].play_url).toBe(ROOT);
    const check = await checkMove(deps, DEV, GAME, null, { fetch: web(site).fetchImpl, resolve: publicDns });
    expect(check).toMatchObject({ ok: false, problem: "engine_storage", engine: "Godot", github: null, suggestRepo: "lu/moon-hop" });
  });

  it("takes the game from its repository when that has the finished game, and follows it", async () => {
    tables.game_git = [];
    const gh = fakeGitHub({ "lu/moon-hop": { main: { "project.godot": "" }, "gh-pages": { "index.html": "<html>gh</html>", "index.pck": "p" } } });
    const out = await moveGame(deps, DEV, GAME, false, { ...opts(), git: { gh, installations: [7] } });
    expect(out).toMatchObject({ source: "github", github: { repo: "lu/moon-hop", branch: "gh-pages", folder: "" }, suggestRepo: null, from: ROOT, saves: true, files: 2 });
    expect(tables.game_git[0]).toMatchObject({ repo: "lu/moon-hop", branch: "gh-pages", status: "live" });
    expect(tables.games[0]).toMatchObject({ play_url: "https://moon-hop.playtoki.app/", moved_from: ROOT });
    await moveBack(deps, DEV, GAME);
    expect(tables.game_git).toEqual([]);
  });

  it("takes the game from its site when the repository has no finished game, and suggests connecting it", async () => {
    tables.game_git = [];
    const gh = fakeGitHub({ "lu/moon-hop": { main: { "project.godot": "", "player.gd": "" } } });
    const out = await moveGame(deps, DEV, GAME, false, { ...opts(), git: { gh, installations: [7] } });
    expect(out).toMatchObject({ source: "site", github: null, files: 15, suggestRepo: "lu/moon-hop" });
    const without = await moveBack(deps, DEV, GAME).then(() => moveGame(deps, DEV, GAME, false, opts()));
    expect(without).toMatchObject({ source: "site", suggestRepo: "lu/moon-hop" });
  });
});

describe("whether players' progress can come along", () => {
  const f = (path: string, text: string | Uint8Array): CrawledFile => ({ path, data: typeof text === "string" ? new TextEncoder().encode(text) : text });

  it("needs Toki's save script at the old address", () => {
    expect(savesVerdict({ files: [f("index.html", "<canvas>")], saveScript: false }, false)).toEqual({ ok: false, problem: "no_script", engine: null });
    expect(savesVerdict({ files: [f("index.html", "<canvas>")], saveScript: true }, false)).toEqual({ ok: true, problem: null, engine: null });
  });

  it("needs a copy of a Godot or Unity game's progress where the script sees it", () => {
    const godot = [f("index.html", "GODOT_CONFIG"), f("index.pck", "GDPC user://save.dat")];
    expect(savesVerdict({ files: godot, saveScript: true }, false)).toEqual({ ok: false, problem: "engine_storage", engine: "Godot" });
    expect(savesVerdict({ files: [godot[0], f("index.pck", "GDPC localStorage")], saveScript: true }, false).ok).toBe(true);
    const unity = (framework: string) => [f("index.html", "createUnityInstance"), f("Build/web.loader.js", "x"), f("Build/web.framework.js.br", new Uint8Array(brotliCompressSync(Buffer.from(framework))))];
    expect(savesVerdict({ files: unity("IDBFS"), saveScript: true }, false)).toMatchObject({ ok: false, problem: "engine_storage", engine: "Unity" });
    expect(savesVerdict({ files: unity("window.localStorage.setItem(k, v)"), saveScript: true }, false).ok).toBe(true);
  });

  it("trusts saves Toki already keeps for the game", () => {
    expect(savesVerdict({ files: [f("index.pck", "x")], saveScript: false }, true).ok).toBe(true);
    expect(savesVerdict(null, true).ok).toBe(true);
    expect(savesVerdict(null, false)).toMatchObject({ ok: false, problem: "unreachable" });
  });
});

/** A pretend GitHub: one installation that reaches the given repositories with their files per branch. */
function fakeGitHub(repos: Record<string, Record<string, Record<string, string>>>) {
  const gh = {
    repos: async () => Object.keys(repos).map((repo) => ({ repo, private: false, defaultBranch: "main" })),
    repo: async (_id: number, name: string) => {
      const branches = repos[name];
      return {
        branches: async () => Object.keys(branches),
        tree: async (b: string) => Object.keys(branches[b]).map((path) => ({ path, type: "blob" })),
        read: async (path: string, b: string) => branches[b][path] ?? "",
        head: async () => ({ sha: "d".repeat(40), message: "Hop higher" }),
        tarball: async (ref: string) => gzipSync(tar(branches[ref] ?? branches["gh-pages"] ?? branches.main)),
        defaultBranch: async () => "main",
      };
    },
  };
  return gh as unknown as GitHubClient;
}

describe("the game's GitHub repository", () => {
  it("knows which repository a GitHub Pages address comes from", () => {
    expect(pagesRepos("https://lu.github.io/moon-hop/play/index.html")).toEqual([{ repo: "lu/moon-hop", sub: "play" }, { repo: "lu/lu.github.io", sub: "moon-hop/play" }]);
    expect(pagesRepos("https://lu.github.io/")).toEqual([{ repo: "lu/lu.github.io", sub: "" }]);
    expect(pagesRepos("https://example.com/moon-hop/")).toEqual([]);
  });

  it("takes the finished game from gh-pages first, else from the main branch", async () => {
    const gh = fakeGitHub({ "lu/moon-hop": { main: { "project.godot": "", "src/player.gd": "" }, "gh-pages": { "index.html": "<html>", "index.pck": "p" } } });
    expect((await findRepoBuild(gh, [7], ROOT)).found).toEqual({ installation_id: 7, repo: "lu/moon-hop", branch: "gh-pages", folder: "" });
    const docs = fakeGitHub({ "lu/moon-hop": { main: { "docs/index.html": "<html>", "README.md": "#" } } });
    expect((await findRepoBuild(docs, [7], ROOT)).found).toMatchObject({ branch: "main", folder: "docs" });
  });

  it("finds no finished game in a project without a web build, and says which repository it was", async () => {
    const gh = fakeGitHub({ "lu/moon-hop": { main: { "project.godot": "", "index.html": '<script type="module" src="/src/main.tsx"></script>', "package.json": '{"scripts":{"build":"vite build"}}' } } });
    expect(await findRepoBuild(gh, [7], ROOT)).toEqual({ found: null, repo: "lu/moon-hop" });
    expect(await findRepoBuild(fakeGitHub({}), [7], ROOT)).toEqual({ found: null, repo: "lu/moon-hop" });
  });
});

describe("bringing players' progress over", () => {
  const memory = (init: Record<string, string> = {}): KeyValue & { data: Record<string, string> } => {
    const data = { ...init };
    return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
  };
  const NOW = Date.parse("2026-12-01T10:00:00Z");
  const game = { id: "g1", slug: "moon-hop", play_url: "https://moon-hop.playtoki.app/", moved_from: ROOT, moved_at: "2026-11-19T10:00:00Z" };

  it("only asks the old address for players who played there and have no save on Toki yet", () => {
    expect(needsPickup(game, undefined, memory(), ["moon-hop"], NOW)).toBe(true);
    expect(needsPickup(game, undefined, memory({ "toki.favorites": '["moon-hop"]' }), [], NOW)).toBe(true);
    expect(needsPickup(game, undefined, memory({ "toki.save.game.g1": "5" }), [], NOW)).toBe(true);
    // never played here: nothing to bring over
    expect(needsPickup(game, undefined, memory(), ["snake"], NOW)).toBe(false);
    // Toki has their save already, or asked before
    const saved = JSON.stringify({ save: { keys: { a: "1" }, t: 5 }, bases: [], dirty: false });
    expect(needsPickup(game, undefined, memory({ "toki.save.anon.g1": saved }), ["moon-hop"], NOW)).toBe(false);
    expect(needsPickup(game, "u1", memory({ "toki.save.u1.g1": saved }), ["moon-hop"], NOW)).toBe(false);
    expect(needsPickup(game, undefined, memory({ "toki.moved.g1": "1" }), ["moon-hop"], NOW)).toBe(false);
    // not moved, moved back, or long ago
    expect(needsPickup({ ...game, moved_from: null }, undefined, memory(), ["moon-hop"], NOW)).toBe(false);
    expect(needsPickup({ ...game, play_url: `${ROOT}index.html` }, undefined, memory(), ["moon-hop"], NOW)).toBe(false);
    expect(needsPickup(game, undefined, memory(), ["moon-hop"], Date.parse("2027-07-01T00:00:00Z"))).toBe(false);
  });

  it("keeps the old progress as this device's save, never over one Toki has", () => {
    const kv = memory();
    expect(keepPickedUp(kv, "g1", "u1", { keys: { level: "7" }, t: 100 })).toEqual({ keys: { level: "7" }, t: 100 });
    expect(readRecord(kv, "u1", "g1")).toEqual({ save: { keys: { level: "7" }, t: 100 }, bases: [], dirty: true });
    expect(keepPickedUp(kv, "g1", "u1", { keys: { level: "1" }, t: 200 })).toBeNull();
    expect(readRecord(kv, "u1", "g1")!.save.keys.level).toBe("7");
    expect(keepPickedUp(memory(), "g1", undefined, { keys: {}, t: 1 })).toBeNull();
    expect(keepPickedUp(memory(), "g1", undefined, "nonsense")).toBeNull();
  });

  describe("talking to the game at its old address", () => {
    let target: EventTarget;
    let sent: unknown[];
    const frameWin = { postMessage: (m: unknown) => sent.push(m) } as unknown as Window;
    const msg = (data: unknown, origin = "https://lu.github.io", source: unknown = frameWin) =>
      target.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));

    beforeEach(() => {
      vi.useFakeTimers();
      target = new EventTarget();
      sent = [];
      vi.stubGlobal("window", target);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("asks for the progress and keeps it", () => {
      const kv = memory();
      const done = vi.fn();
      listenForPickup({ frame: () => frameWin, from: ROOT, gameId: "g1", userId: undefined, kv, done });
      msg({ toki: 1, type: "hello" }, "https://evil.example"); // another site: ignored
      msg({ toki: 1, type: "hello" }, "https://lu.github.io", {}); // another window: ignored
      expect(sent).toEqual([]);
      msg({ toki: 1, type: "hello" });
      expect(sent).toEqual([{ toki: 1, type: "save", data: null }]);
      msg({ toki: 1, type: "store", data: { keys: { level: "7" }, t: 100 } });
      expect(done).toHaveBeenCalledWith(true);
      expect(readRecord(kv, "anon", "g1")!.save.keys).toEqual({ level: "7" });
      expect(kv.data["toki.moved.g1"]).toBeTruthy();
    });

    it("goes on when the game there has nothing stored", () => {
      const done = vi.fn();
      listenForPickup({ frame: () => frameWin, from: ROOT, gameId: "g1", userId: undefined, kv: memory(), done });
      msg({ toki: 1, type: "hello" });
      vi.advanceTimersByTime(STORE_MS + 1);
      expect(done).toHaveBeenCalledWith(false);
    });

    it("goes on when the old address doesn't answer", () => {
      const kv = memory();
      const done = vi.fn();
      listenForPickup({ frame: () => frameWin, from: ROOT, gameId: "g1", userId: undefined, kv, done });
      vi.advanceTimersByTime(HELLO_MS + 1);
      expect(done).toHaveBeenCalledWith(false);
      expect(kv.data["toki.moved.g1"]).toBeTruthy();
    });
  });
});
