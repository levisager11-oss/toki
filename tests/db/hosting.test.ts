import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let otherDev: { id: string };
let player: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  player = await t.user();
}, 60_000);

const build = async (gameId: string, by: string) =>
  (await t.service<{ id: string }>("insert into game_builds (game_id, site, created_by, status) values ($1, 'snake', $2, 'live') returning id", [gameId, by]))[0].id;

describe("hosted games", () => {
  it("only lets the server set a game's hosting address", async () => {
    const g = await t.game(dev);
    await t.as(dev, "update games set hosted_site = 'mine' where id = $1", [g.id]);
    expect((await t.admin<{ hosted_site: string | null }>("select hosted_site from games where id = $1", [g.id]))[0].hosted_site).toBeNull();
    await t.service("update games set hosted_site = 'snake-x' where id = $1", [g.id]);
    await t.as(admin, "update games set hosted_site = 'other' where id = $1", [g.id]);
    expect((await t.admin<{ hosted_site: string }>("select hosted_site from games where id = $1", [g.id]))[0].hosted_site).toBe("snake-x");
    const [added] = await t.as<{ hosted_site: string | null }>(
      dev,
      "insert into games (slug, title, category, play_url, hosted_site) values ('hosted-try', 'X', 'arcade', 'https://example.com', 'stolen') returning hosted_site",
    );
    expect(added.hosted_site).toBeNull();
  });

  it("shows a game's versions to its developer and admins only", async () => {
    const g = await t.game(dev);
    await build(g.id, dev.id);
    expect(await t.as(dev, "select id from game_builds where game_id = $1", [g.id])).toHaveLength(1);
    expect(await t.as(admin, "select id from game_builds where game_id = $1", [g.id])).toHaveLength(1);
    expect(await t.as(otherDev, "select id from game_builds where game_id = $1", [g.id])).toHaveLength(0);
    expect(await t.as(player, "select id from game_builds where game_id = $1", [g.id])).toHaveLength(0);
    await expect(t.as(null, "select id from game_builds")).rejects.toThrow(/permission denied/);
  });

  it("doesn't let anyone but the server write versions", async () => {
    const g = await t.game(dev);
    await expect(t.as(dev, "insert into game_builds (game_id, site) values ($1, 'x')", [g.id])).rejects.toThrow(/permission denied/);
    const id = await build(g.id, dev.id);
    await expect(t.as(dev, "update game_builds set status = 'previous' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "delete from game_builds where id = $1", [id])).rejects.toThrow(/permission denied/);
  });

  it("marks a deleted game's files for deletion", async () => {
    const g = await t.game(dev);
    const id = await build(g.id, dev.id);
    await t.as(dev, "delete from games where id = $1", [g.id]);
    const [row] = await t.admin<{ status: string; delete_after: string | null }>("select status, delete_after from game_builds where id = $1", [id]);
    expect(row.status).toBe("deleting");
    expect(row.delete_after).not.toBeNull();
  });
});

describe("upload keys", () => {
  const hash = (c: string) => c.repeat(64);

  it("lets owners see and delete their keys, without the hash", async () => {
    const [k] = await t.service<{ id: string }>("insert into upload_keys (user_id, name, key_hash, hint) values ($1, 'GitHub', $2, 'abcd') returning id", [dev.id, hash("a")]);
    expect(await t.as(dev, "select id, name, hint from upload_keys")).toHaveLength(1);
    await expect(t.as(dev, "select key_hash from upload_keys")).rejects.toThrow(/permission denied/);
    expect(await t.as(otherDev, "select id from upload_keys where id = $1", [k.id])).toHaveLength(0);
    await t.as(otherDev, "delete from upload_keys where id = $1", [k.id]);
    expect(await t.admin("select id from upload_keys where id = $1", [k.id])).toHaveLength(1);
    await t.as(dev, "delete from upload_keys where id = $1", [k.id]);
    expect(await t.admin("select id from upload_keys where id = $1", [k.id])).toHaveLength(0);
  });

  it("doesn't let accounts make keys themselves", async () => {
    await expect(t.as(dev, "insert into upload_keys (user_id, name, key_hash, hint) values ($1, 'x', $2, 'x')", [dev.id, hash("b")])).rejects.toThrow(/permission denied/);
  });

  it("accepts the Cloudflare settings as a server secret", async () => {
    await t.service("insert into server_secrets (name, value) values ('cloudflare_r2', 'v1:x')");
    await expect(t.service("insert into server_secrets (name, value) values ('other', 'v1:x')")).rejects.toThrow(/check constraint/);
  });
});

describe("games that follow a GitHub repository", () => {
  it("shows the link to the game's developer only, and only the server writes it", async () => {
    const g = await t.game(dev);
    await t.service("insert into game_git (game_id, installation_id, repo, branch) values ($1, 1, 'lu/moon-hop', 'main')", [g.id]);
    expect(await t.as(dev, "select repo from game_git where game_id = $1", [g.id])).toEqual([{ repo: "lu/moon-hop" }]);
    expect(await t.as(otherDev, "select repo from game_git where game_id = $1", [g.id])).toHaveLength(0);
    await expect(t.as(dev, "update game_git set branch = 'x' where game_id = $1", [g.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "insert into game_git (game_id, installation_id, repo, branch) values ($1, 1, 'a/b', 'main')", [g.id])).rejects.toThrow(/permission denied/);
    await t.as(dev, "delete from games where id = $1", [g.id]);
    expect(await t.admin("select 1 from game_git where game_id = $1", [g.id])).toHaveLength(0);
  });
});

describe("one-click add", () => {
  it("lets admins choose which model adds leaderboard code", async () => {
    const model = () => t.admin<{ model: string }>("select model from ai_features where feature = 'connect_quick'").then((r) => r[0].model);
    expect(await model()).toBe("claude-sonnet-5-5");
    await t.as(admin, "update ai_features set model = 'claude-haiku-5-5', input_price = 0.1, output_price = 0.5 where feature = 'connect_quick'");
    expect(await model()).toBe("claude-haiku-5-5");
    await t.as(dev, "update ai_features set model = '' where feature = 'connect_quick'");
    expect(await model()).toBe("claude-haiku-5-5");
  });

  it("keeps runs on uploaded games without a GitHub installation, and GitHub runs with one", async () => {
    await t.service("insert into connect_jobs (user_id, repo, features, source, ai) values ($1, 'toki/snake', '{scores}', 'upload', 'quick')", [dev.id]);
    await expect(t.service("insert into connect_jobs (user_id, repo, features) values ($1, 'a/b', '{scores}')", [otherDev.id])).rejects.toThrow(/connect_jobs_installation_check/);
  });
});

describe("moving a game to Toki", () => {
  it("only lets the server remember a game's old address", async () => {
    const g = await t.game(dev);
    await t.as(dev, "update games set moved_from = 'https://evil.example', moved_at = now() where id = $1", [g.id]);
    expect((await t.admin<{ moved_from: string | null }>("select moved_from from games where id = $1", [g.id]))[0].moved_from).toBeNull();
    await t.service("update games set moved_from = 'https://lu.github.io/moon-hop/', moved_at = now() where id = $1", [g.id]);
    await t.as(admin, "update games set moved_from = null where id = $1", [g.id]);
    await t.as(dev, "update games set title = 'Moon Hop' where id = $1", [g.id]);
    const [row] = await t.admin<{ moved_from: string; moved_at: string | null }>("select moved_from, moved_at from games where id = $1", [g.id]);
    expect(row.moved_from).toBe("https://lu.github.io/moon-hop/");
    expect(row.moved_at).not.toBeNull();
    const [added] = await t.as<{ moved_from: string | null }>(
      dev,
      "insert into games (slug, title, category, play_url, moved_from) values ('moved-try', 'X', 'arcade', 'https://example.com', 'https://x.example') returning moved_from",
    );
    expect(added.moved_from).toBeNull();
  });

  it("lets everyone read where a game was before, so players' progress can come along", async () => {
    const g = await t.game(dev);
    await t.service("update games set moved_from = 'https://lu.github.io/moon-hop/', moved_at = now() where id = $1", [g.id]);
    const [row] = await t.as<{ moved_from: string }>(null, "select moved_from from games where id = $1", [g.id]);
    expect(row.moved_from).toBe("https://lu.github.io/moon-hop/");
  });
});

describe("games built by GitHub Actions", () => {
  it("shows the developer how their game is built, and only the server changes it", async () => {
    const g = await t.game(dev);
    await t.service("insert into game_git (game_id, installation_id, repo, branch, build, build_pr) values ($1, 1, 'lu/moon-hop', 'main', 'action', 'https://github.com/lu/moon-hop/pull/3')", [g.id]);
    expect(await t.as(dev, "select build, build_pr from game_git where game_id = $1", [g.id])).toEqual([{ build: "action", build_pr: "https://github.com/lu/moon-hop/pull/3" }]);
    await expect(t.as(dev, "update game_git set build = 'none' where game_id = $1", [g.id])).rejects.toThrow(/permission denied/);
    await expect(t.service("update game_git set build = 'docker' where game_id = $1", [g.id])).rejects.toThrow(/check/);
    await expect(t.service("update game_git set build_pr = 'https://evil.example/x' where game_id = $1", [g.id])).rejects.toThrow(/check/);
  });
});
