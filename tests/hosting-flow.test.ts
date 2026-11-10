// The whole hosting flow (start → upload → finish → roll back → clean-up) against a small
// in-memory stand-in for the database's REST API and for Cloudflare R2.
import { beforeEach, describe, expect, it } from "vitest";
import { finishUpload, HostingError, rollBack, startUpload, sweep, type Deps } from "../server/hosting";
import { buildRepo } from "../server/connect/buildRepo";

import { fakeDb, fakeStore, type Row } from "./fakes";

const DEV = { id: "dev", role: "creator" as const };
const OTHER = { id: "other", role: "creator" as const };
let tables: Record<string, Row[]>;
let files: Map<string, number>;
let pointers: Map<string, string>;
let now: Date;
let deps: Deps;

/** Does what the browser does with the upload links. */
const uploadAll = (start: { uploads: { url: string; size: number }[] }) => {
  for (const u of start.uploads) files.set(decodeURIComponent(new URL(u.url).pathname.slice(1)), u.size);
};

beforeEach(() => {
  tables = {
    games: [{ id: "11111111-1111-4111-8111-111111111111", slug: "snake", title: "Snake", created_by: "dev", hosted_site: null, needs_isolation: false, thumbnail_url: null, screenshots: [], old_slugs: [] }],
    game_builds: [],
    game_releases: [],
  };
  files = new Map();
  pointers = new Map();
  now = new Date("2026-11-15T10:00:00Z");
  deps = { db: fakeDb(tables), store: fakeStore(files, pointers), config: { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "games", domain: "playtoki.app" }, now: () => now };
});

const game = () => tables.games[0];
const FILES = [{ path: "Snake/index.html", size: 100 }, { path: "Snake/game.js", size: 200 }];

describe("hosting a game", () => {
  it("remembers the link a game ran at before, so players' progress comes along", async () => {
    game().play_url = "https://lu.itch.io/snake";
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(s);
    await finishUpload(deps, DEV, { build_id: s.build_id });
    expect(game()).toMatchObject({ play_url: "https://snake.playtoki.app/", moved_from: "https://lu.itch.io/snake", moved_at: now.toISOString() });
    // A new version of a game that is on Toki already doesn't change it.
    now = new Date("2026-11-16T10:00:00Z");
    const s2 = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(s2);
    await finishUpload(deps, DEV, { build_id: s2.build_id });
    expect(game().moved_at).toBe("2026-11-15T10:00:00.000Z");
  });

  it("uploads, goes live at the game's own address and takes over toki.json", async () => {
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    expect(s).toMatchObject({ site: "snake", entry: "index.html", bytes: 300 });
    expect(s.uploads.map((u) => u.path)).toEqual(["Snake/index.html", "Snake/game.js"]);
    uploadAll(s);
    const f = await finishUpload(deps, DEV, {
      build_id: s.build_id,
      toki: { title: "Snake Deluxe", version: "1.1", notes: ["Faster"], screenshots: ["shots/1.png"], controls: "Arrows" },
    });
    expect(f.play_url).toBe("https://snake.playtoki.app/");
    expect(game()).toMatchObject({ title: "Snake Deluxe", hosted_site: "snake", controls: "Arrows", screenshots: ["https://snake.playtoki.app/shots/1.png"] });
    expect(JSON.parse(pointers.get("sites/snake.json")!)).toEqual({ build: s.build_id, entry: "index.html", isolation: false });
    expect(tables.game_releases).toMatchObject([{ game_id: "11111111-1111-4111-8111-111111111111", version: "1.1", notes: "- Faster", small: false }]);
  });

  it("doesn't go live when files are missing or other people's", async () => {
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    await expect(finishUpload(deps, DEV, { build_id: s.build_id })).rejects.toThrow("missing_files");
    await expect(startUpload(deps, OTHER, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES })).rejects.toThrow("not_allowed");
    await expect(finishUpload(deps, OTHER, { build_id: s.build_id })).rejects.toThrow("not_allowed");
    await expect(startUpload(deps, { id: "p", role: "player" }, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES })).rejects.toBeInstanceOf(HostingError);
  });

  it("refuses files bigger than announced", async () => {
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(s);
    files.set(`b/${s.build_id}/game.js`, 999_999);
    await expect(finishUpload(deps, DEV, { build_id: s.build_id })).rejects.toThrow("too_big");
  });

  it("keeps the version before for 30 days, rolls back, and deletes what is due", async () => {
    const one = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(one);
    await finishUpload(deps, DEV, { build_id: one.build_id });
    const two = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(two);
    await finishUpload(deps, DEV, { build_id: two.build_id });
    const byId = (id: string) => tables.game_builds.find((b) => b.id === id)!;
    expect(byId(one.build_id)).toMatchObject({ status: "previous", delete_after: "2026-12-15T10:00:00.000Z" });

    await rollBack(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111" });
    expect(JSON.parse(pointers.get("sites/snake.json")!).build).toBe(one.build_id);
    expect(byId(two.build_id).status).toBe("previous");

    const three = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(three);
    await finishUpload(deps, DEV, { build_id: three.build_id });
    // Only one earlier version is kept: the oldest went at once.
    expect(tables.game_builds.map((b) => b.id)).not.toContain(two.build_id);
    expect([...files.keys()].some((k) => k.startsWith(`b/${two.build_id}/`))).toBe(false);

    now = new Date("2026-12-16T10:00:00Z");
    await sweep(deps);
    expect(tables.game_builds.map((b) => b.status)).toEqual(["live"]);
    expect([...files.keys()].every((k) => k.startsWith(`b/${three.build_id}/`))).toBe(true);
  });

  it("creates a new game from toki.json for an upload key, but never takes someone else's slug", async () => {
    const s = await startUpload(deps, DEV, { files: [{ path: "index.html", size: 5 }], toki: { title: "Space Run", category: "racing" } });
    expect(s).toMatchObject({ created: true, slug: "space-run", site: "space-run" });
    expect(tables.games.find((g) => g.slug === "space-run")).toMatchObject({ created_by: "dev", category: "racing" });
    await expect(startUpload(deps, OTHER, { slug: "space-run", files: [{ path: "index.html", size: 5 }] })).rejects.toThrow("slug_taken");
  });

  it("deletes a deleted game's files and stops its address", async () => {
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(s);
    await finishUpload(deps, DEV, { build_id: s.build_id });
    // What the database trigger does when the game is deleted:
    tables.games = [];
    for (const b of tables.game_builds) Object.assign(b, { status: "deleting", delete_after: now.toISOString() });
    await sweep(deps);
    expect(files.size).toBe(0);
    expect(pointers.has("sites/snake.json")).toBe(false);
  });

  it("deletes uploads that were never finished after a day", async () => {
    const s = await startUpload(deps, DEV, { game_id: "11111111-1111-4111-8111-111111111111", files: FILES });
    uploadAll(s);
    now = new Date("2026-11-17T10:00:00Z");
    await sweep(deps);
    expect(files.size).toBe(0);
    expect(tables.game_builds).toHaveLength(0);
  });

  it("lets Toki Connect change an uploaded game: its change goes live as the next version", async () => {
    const s1 = await startUpload(deps, DEV, { game_id: game().id, files: FILES });
    uploadAll(s1);
    await finishUpload(deps, DEV, { build_id: s1.build_id });
    const repo = await buildRepo(deps, DEV, game().id as string);
    expect((await repo.tree("live")).map((e) => e.path).sort()).toEqual(["game.js", "index.html"]);
    const url = await repo.openPullRequest({ base: "live", branch: "x", title: "t", body: "b", message: "m", files: { "game.js": "toki.score(1)" } });
    expect(url).toBe("");
    const live = tables.game_builds.find((b) => b.status === "live")!;
    expect(live.id).not.toBe(s1.build_id);
    expect(files.get(`b/${live.id}/game.js`)).toBe(13);
    expect(files.get(`b/${live.id}/index.html`)).toBe(100);
    expect(JSON.parse(pointers.get("sites/snake.json")!).build).toBe(live.id);
    expect(tables.game_builds.find((b) => b.id === s1.build_id)!.status).toBe("previous");
  });
});
