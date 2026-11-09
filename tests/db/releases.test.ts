import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let otherDev: { id: string };
let player: { id: string };
let game: { id: string };
let otherGame: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  game = await t.game(dev);
  otherGame = await t.game(otherDev);
}, 60_000);

// A new player for each test, so the hourly post limit doesn't add up across tests.
beforeEach(async () => {
  player = await t.user();
});

type Release = { id: string; version: string; title: string | null; created_by: string; edited_at: string | null };
let v = 0;
async function release(who: Who, gameId: string | null = game.id, version = `1.${++v}`) {
  const [r] = await t.as<Release>(who, "insert into game_releases (game_id, version, title, notes) values ($1, $2, '  Big update ', '- New level') returning *", [gameId, version]);
  return r;
}
async function post(gameId: string | null = game.id, kind = "bug") {
  const [p] = await t.as<{ id: string }>(player, "insert into feedback_posts (game_id, kind, title) values ($1, $2, 'Something to fix') returning id", [gameId, kind]);
  return p.id;
}
const fixes = (who: Who, releaseId: string, posts: string[]) =>
  t.as<{ set_release_fixes: number }>(who, "select set_release_fixes($1, $2::uuid[])", [releaseId, posts]).then((r) => r[0].set_release_fixes);
const postRow = async (id: string) => (await t.admin<{ status: string; fixed_in: string | null }>("select status, fixed_in from feedback_posts where id = $1", [id]))[0];

describe("release notes", () => {
  it("lets the game's developer post one that everyone can read", async () => {
    const r = await release(dev);
    expect(r).toMatchObject({ created_by: dev.id, title: "Big update" });
    expect(await t.as(null, "select id from game_releases where id = $1", [r.id])).toHaveLength(1);
  });

  it("doesn't let players or other developers post for a game", async () => {
    await expect(release(player)).rejects.toThrow(/row-level security/);
    await expect(release(otherDev)).rejects.toThrow(/row-level security/);
    await expect(release(null)).rejects.toThrow(/permission denied/);
  });

  it("lets only admins post updates of Toki itself", async () => {
    await expect(release(dev, null)).rejects.toThrow(/row-level security/);
    expect(await release(admin, null)).toBeDefined();
  });

  it("allows each version once per game", async () => {
    await release(dev, game.id, "2.0");
    await expect(release(dev, game.id, "2.0")).rejects.toThrow(/duplicate key/);
    await release(admin, null, "2.0");
    await expect(release(admin, null, "2.0")).rejects.toThrow(/duplicate key/);
  });

  it("lets the developer edit and delete, not others", async () => {
    const r = await release(dev);
    expect(await t.as(otherDev, "update game_releases set notes = 'x' where id = $1 returning id", [r.id])).toHaveLength(0);
    expect(await t.as(player, "delete from game_releases where id = $1 returning id", [r.id])).toHaveLength(0);
    const [u] = await t.as<Release>(dev, "update game_releases set version = ' 9.9 ' where id = $1 returning *", [r.id]);
    expect(u.version).toBe("9.9");
    expect(u.edited_at).not.toBeNull();
    await expect(t.as(dev, "update game_releases set game_id = $2 where id = $1", [r.id, otherGame.id])).rejects.toThrow(/permission denied/);
    expect(await t.as(admin, "delete from game_releases where id = $1 returning id", [r.id])).toHaveLength(1);
  });
});

describe("linking feedback to an update", () => {
  it("marks the linked posts done", async () => {
    const r = await release(dev);
    const [a, b] = [await post(), await post(game.id, "idea")];
    expect(await fixes(dev, r.id, [a, b])).toBe(2);
    expect(await postRow(a)).toEqual({ status: "done", fixed_in: r.id });
    expect(await postRow(b)).toEqual({ status: "done", fixed_in: r.id });
  });

  it("unlinks posts left out, without changing their status", async () => {
    const r = await release(dev);
    const [a, b] = [await post(), await post()];
    await fixes(dev, r.id, [a, b]);
    expect(await fixes(dev, r.id, [a])).toBe(1);
    expect(await postRow(b)).toEqual({ status: "done", fixed_in: null });
  });

  it("only links posts about the same game", async () => {
    const r = await release(dev);
    const elsewhere = await post(otherGame.id);
    const toki = await post(null);
    await expect(fixes(dev, r.id, [elsewhere])).rejects.toThrow(/wrong_game/);
    await expect(fixes(dev, r.id, [toki])).rejects.toThrow(/wrong_game/);
    await expect(fixes(dev, r.id, [crypto.randomUUID()])).rejects.toThrow(/wrong_game/);
  });

  it("doesn't let players or other developers link posts", async () => {
    const r = await release(dev);
    const a = await post();
    await expect(fixes(player, r.id, [a])).rejects.toThrow(/not_allowed/);
    await expect(fixes(otherDev, r.id, [a])).rejects.toThrow(/not_allowed/);
    await expect(t.as(null, "select set_release_fixes($1, $2::uuid[])", [r.id, [a]])).rejects.toThrow(/permission denied/);
    expect(await postRow(a)).toEqual({ status: "open", fixed_in: null });
  });

  it("doesn't let anyone set fixed_in directly", async () => {
    const r = await release(dev);
    const a = await post();
    await expect(t.as(dev, "update feedback_posts set fixed_in = $2 where id = $1", [a, r.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(player, "insert into feedback_posts (game_id, kind, title, fixed_in) values ($1, 'bug', 'abc', $2)", [game.id, r.id])).rejects.toThrow(/permission denied/);
  });

  it("keeps the posts when the update is deleted", async () => {
    const r = await release(dev);
    const a = await post();
    await fixes(dev, r.id, [a]);
    await t.as(dev, "delete from game_releases where id = $1", [r.id]);
    expect(await postRow(a)).toEqual({ status: "done", fixed_in: null });
  });

  it("lets admins link posts of Toki updates", async () => {
    const r = await release(admin, null);
    const a = await post(null, "idea");
    expect(await fixes(admin, r.id, [a])).toBe(1);
  });

  it("hides private posts linked to an update from other players", async () => {
    const r = await release(dev);
    const [p] = await t.as<{ id: string }>(player, "insert into feedback_posts (game_id, kind, title, private) values ($1, 'bug', 'Secret crash', true) returning id", [game.id]);
    await fixes(dev, r.id, [p.id]);
    const stranger = await t.user();
    expect(await t.as(stranger, "select id from feedback_posts where fixed_in = $1", [r.id])).toHaveLength(0);
    expect(await t.as(player, "select id from feedback_posts where fixed_in = $1", [r.id])).toHaveLength(1);
  });
});
