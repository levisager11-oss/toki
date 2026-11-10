import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deployCommit, filesIn, gamesForPush, openRepo, readTar, validSignature } from "../server/gitDeploy";
import type { Db } from "../server/db";
import { GitHubError, type GitHubClient } from "../server/github";
import type { Deps } from "../server/hosting";
import { tar } from "./fakes";

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
    const gh = { repo: async () => ({ name: async () => "lu/moon-hop", tarball: async () => tarball, head: async () => ({ sha: "b".repeat(40), message: "x" }) }) } as unknown as GitHubClient;
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

describe("a game whose GitHub connection changed", () => {
  const SHA = "a".repeat(40);
  const row = () => ({ game_id: "g", installation_id: 7, repo: "lu/moon-hop", branch: "main", folder: "", created_by: "dev" });
  /** game_git rows, and the connections each Toki account has */
  const fakeDb = (installs: { user_id: string; installation_id: number }[]) => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      select: async (table: string, q: string) => {
        if (table === "game_git") return [row()];
        const id = /installation_id=eq\.(\d+)/.exec(q)?.[1];
        const users = /user_id=in\.\(([^)]*)\)/.exec(q)?.[1]?.split(",");
        return installs.filter((i) => (!id || String(i.installation_id) === id) && (!users || users.includes(i.user_id)));
      },
      update: async (_t: string, _q: string, patch: Record<string, unknown>) => void updates.push(patch),
    } as unknown as Db;
    return { db, updates };
  };
  /** GitHub where only installation 9 still exists, and the repository was renamed to "lu/Moon-Hop" */
  const gh = (reachable = new Set([9])) =>
    ({
      repo: async (id: number, name: string) => {
        if (!reachable.has(id)) throw new GitHubError("GitHub 404: Not Found", 404);
        return { name: async () => "lu/Moon-Hop", used: name, id };
      },
    }) as unknown as GitHubClient;

  it("switches to the developer's connection that still reaches the repository, and saves it", async () => {
    const { db, updates } = fakeDb([{ user_id: "dev", installation_id: 7 }, { user_id: "dev", installation_id: 9 }]);
    const r = row();
    const repo = (await openRepo(db, gh(), r, "dev")) as unknown as { used: string; id: number };
    expect(repo).toMatchObject({ used: "lu/Moon-Hop", id: 9 });
    expect(r).toMatchObject({ installation_id: 9, repo: "lu/Moon-Hop" });
    expect(updates).toEqual([{ installation_id: 9, repo: "lu/Moon-Hop" }]);
  });

  it("says so in plain words when no connection reaches it", async () => {
    const { db } = fakeDb([{ user_id: "dev", installation_id: 7 }]);
    await expect(openRepo(db, gh(), row(), "dev")).rejects.toMatchObject({ code: "repo_lost" });
  });

  it("doesn't switch for other problems (GitHub down)", async () => {
    const { db } = fakeDb([{ user_id: "dev", installation_id: 9 }]);
    const down = { repo: async () => { throw new GitHubError("GitHub 502: Bad Gateway", 502); } } as unknown as GitHubClient;
    await expect(openRepo(db, down, row(), "dev")).rejects.toMatchObject({ status: 502 });
  });

  it("follows pushes from the developer's new connection", async () => {
    const { db, updates } = fakeDb([{ user_id: "dev", installation_id: 9 }]);
    const hit = await gamesForPush(db, { ref: "refs/heads/main", after: SHA, repository: { full_name: "lu/moon-hop" }, installation: { id: 9 } });
    expect(hit?.rows).toEqual([{ ...row(), installation_id: 9 }]);
    expect(updates).toEqual([{ installation_id: 9 }]);
  });

  it("ignores pushes from someone else's connection", async () => {
    const { db } = fakeDb([{ user_id: "someone", installation_id: 9 }]);
    expect(await gamesForPush(db, { ref: "refs/heads/main", after: SHA, repository: { full_name: "lu/moon-hop" }, installation: { id: 9 } })).toBeNull();
  });
});
