import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let dev: { id: string };
let otherDev: { id: string };
let admin: { id: string };
let player: { id: string };
let friend: { id: string };
let game: { id: string };
let otherGame: { id: string };

const LIST = [
  { id: "first-win", name: "First win", name_de: "Erster Sieg", description: "Win a round.", description_de: "Gewinn eine Runde.", icon: "🥇" },
  { id: "speedy", name: "Speedy", description: "Finish in under a minute.", icon: "⚡" },
  { id: "Collector.10", name: "Collector", icon: "" },
];

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  admin = await t.user("admin");
  player = await t.user();
  friend = await t.user();
  game = await t.game(dev);
  otherGame = await t.game(otherDev);
}, 60_000);

const set = (who: Who, g: string, list: unknown, mode = "replace") =>
  t.as<{ n: number }>(who, "select public.set_achievements($1, $2::jsonb, $3) as n", [g, JSON.stringify(list), mode]).then((r) => r[0].n);
const unlock = (who: Who, g: string, id: string) =>
  t.as<{ r: { new: boolean; at?: string; full?: boolean } | null }>(who, "select public.unlock_achievement($1, $2) as r", [g, id]).then((r) => r[0].r);
type Row = { id: string; name: string; name_de: string | null; icon: string; players: string; mine: string | null };
const list = (who: Who, g: string) => t.as<Row>(who, "select * from public.game_achievement_list($1)", [g]);
const badges = (who: Who, user: string, limit = 24) =>
  t.as<{ game_id: string; id: string; total: string }>(who, "select * from public.player_achievements($1, $2)", [user, limit]);

describe("defining achievements", () => {
  it("lets the game's developer set the list, in order, with a default icon", async () => {
    expect(await set(dev, game.id, LIST)).toBe(3);
    const rows = await list(null, game.id);
    expect(rows.map((r) => r.id)).toEqual(["first-win", "speedy", "Collector.10"]);
    expect(rows[0]).toMatchObject({ name: "First win", name_de: "Erster Sieg", icon: "🥇" });
    expect(rows[1].name_de).toBeNull(); // German falls back to English in the app
    expect(rows[2].icon).toBe("🏆");
  });

  it("is only for the game's developer, admins and the server", async () => {
    for (const who of [otherDev, player, null]) await expect(set(who, game.id, LIST)).rejects.toThrow();
    expect(await set(admin, otherGame.id, [{ id: "a", name: "A" }])).toBe(1);
    expect(await t.service<{ n: number }>("select public.set_achievements($1, $2::jsonb) as n", [otherGame.id, JSON.stringify([{ id: "b", name: "B" }])]))
      .toEqual([{ n: 1 }]);
    // Nobody writes the tables directly.
    await expect(t.as(dev, "insert into game_achievements (game_id, id, name) values ($1, 'x', 'X')", [game.id])).rejects.toThrow();
    await expect(t.as(player, "insert into achievement_unlocks (user_id, game_id, achievement) values ($1, $2, 'speedy')", [player.id, game.id])).rejects.toThrow();
  });

  it("refuses bad lists: more than 30, bad or repeated ids, missing names", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `a${i}`, name: `A ${i}` }));
    await expect(set(dev, game.id, many)).rejects.toThrow(/too_many_achievements/);
    await expect(set(dev, game.id, [{ id: "has space", name: "X" }])).rejects.toThrow(/bad_achievements/);
    await expect(set(dev, game.id, [{ id: "a", name: "A" }, { id: "a", name: "B" }])).rejects.toThrow(/bad_achievements/);
    await expect(set(dev, game.id, [{ id: "a", name: "" }])).rejects.toThrow();
    await expect(set(dev, game.id, { id: "a" })).rejects.toThrow(/bad_achievements/);
    expect((await list(null, game.id)).length).toBe(3); // unchanged
  });
});

describe("unlocking", () => {
  it("unlocks a defined achievement once; repeats are free", async () => {
    expect(await unlock(player, game.id, "first-win")).toMatchObject({ new: true });
    expect(await unlock(player, game.id, "first-win")).toMatchObject({ new: false });
    expect(await t.admin("select 1 from achievement_unlocks where user_id = $1", [player.id])).toHaveLength(1);
  });

  it("ignores ids the game doesn't have, and needs an account", async () => {
    expect(await unlock(player, game.id, "nope")).toBeNull();
    expect(await unlock(player, otherGame.id, "first-win")).toBeNull();
    await expect(unlock(null, game.id, "first-win")).rejects.toThrow();
  });

  it("shows how many players have each, and which the viewer has", async () => {
    await unlock(friend, game.id, "first-win");
    await unlock(friend, game.id, "speedy");
    const mine = await list(player, game.id);
    expect(mine.map((r) => [r.id, Number(r.players), !!r.mine])).toEqual([["first-win", 2, true], ["speedy", 1, false], ["Collector.10", 0, false]]);
    expect((await list(null, game.id)).every((r) => r.mine === null)).toBe(true);
  });

  it("shows a player's badges newest first, with the game", async () => {
    await t.admin("update achievement_unlocks set unlocked_at = now() - interval '1 day' where user_id = $1 and achievement = 'first-win'", [friend.id]);
    const rows = await badges(null, friend.id);
    expect(rows.map((r) => r.id)).toEqual(["speedy", "first-win"]);
    expect(rows[0].game_id).toBe(game.id);
    expect(Number(rows[0].total)).toBe(2);
    const one = await badges(null, friend.id, 1);
    expect(one).toHaveLength(1);
    expect(Number(one[0].total)).toBe(2); // all of them, not just the ones shown
  });
});

describe("changing the list", () => {
  it("keeps unlocks of achievements that stay, and deletes the ones left out with their unlocks", async () => {
    expect(await set(dev, game.id, [{ ...LIST[1], name: "Quick" }, LIST[0]])).toBe(2);
    expect((await list(player, game.id)).map((r) => [r.id, r.name, Number(r.players)])).toEqual([["speedy", "Quick", 1], ["first-win", "First win", 2]]);
    expect(await t.admin("select 1 from achievement_unlocks where achievement = 'Collector.10'")).toHaveLength(0);
  });

  it("from toki.json: adds and updates, but deletes nothing", async () => {
    expect(await set(dev, game.id, [{ id: "first-win", name: "First victory", icon: "🏅" }, { id: "boss", name: "Boss" }], "merge")).toBe(3);
    const rows = await list(null, game.id);
    expect(rows.map((r) => [r.id, r.name, Number(r.players)])).toEqual([["first-win", "First victory", 2], ["speedy", "Quick", 1], ["boss", "Boss", 0]]);
    await expect(set(dev, game.id, [], "everything")).rejects.toThrow(/bad_achievements/);
  });

  it("from Toki Connect: adds only new ones, after the others, up to 30", async () => {
    const proposed = [{ id: "speedy", name: "Changed" }, ...Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `P ${i}` }))];
    await expect(set(dev, game.id, proposed, "add")).rejects.toThrow(/too_many/); // still at most 30 asked
    expect(await set(dev, game.id, proposed.slice(0, 30), "add")).toBe(30);
    const rows = await list(null, game.id);
    expect(rows.find((r) => r.id === "speedy")?.name).toBe("Quick"); // existing ones stay as they are
    expect(rows.slice(0, 4).map((r) => r.id)).toEqual(["first-win", "speedy", "boss", "p0"]);
    expect(await set(dev, game.id, [{ id: "one-more", name: "One more" }], "merge")).toBe(30); // full
  });

  it("goes when the game is deleted", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, [{ id: "x", name: "X" }]);
    await unlock(player, g.id, "x");
    await t.admin("delete from games where id = $1", [g.id]);
    expect(await t.admin("select 1 from achievement_unlocks where game_id = $1", [g.id])).toHaveLength(0);
  });
});

describe("unlocks from before logging in", () => {
  it("move to the account, leaving out unknown ones and keeping the time", async () => {
    const newbie = await t.user();
    const at = Date.now() - 3600_000;
    const moved = await t.as<{ n: number }>(newbie, "select public.claim_achievements($1::jsonb) as n", [JSON.stringify([
      { game: game.id, id: "speedy", at },
      { game: game.id, id: "speedy", at: at + 5 },
      { game: game.id, id: "nope", at },
      { game: "not-a-uuid", id: "speedy" },
      { game: game.id.toUpperCase(), id: "first-win", at: "bad" },
      "junk",
    ])]);
    expect(moved[0].n).toBe(2);
    const rows = await t.admin<{ achievement: string; unlocked_at: Date }>("select achievement, unlocked_at from achievement_unlocks where user_id = $1 order by achievement", [newbie.id]);
    expect(rows.map((r) => r.achievement)).toEqual(["first-win", "speedy"]);
    expect(Math.abs(new Date(rows[1].unlocked_at).getTime() - at)).toBeLessThan(1000);
    // Again: nothing new.
    expect((await t.as<{ n: number }>(newbie, "select public.claim_achievements($1::jsonb) as n", [JSON.stringify([{ game: game.id, id: "speedy" }])]))[0].n).toBe(0);
    await expect(t.as(null, "select public.claim_achievements('[]'::jsonb)")).rejects.toThrow();
  });
});

describe("Toki Connect", () => {
  it("may add achievements to a game", async () => {
    await t.admin(
      "insert into connect_jobs (user_id, game_id, installation_id, repo, features, status) values ($1, $2, 1, 'dev/game', array['scores', 'achievements'], 'done')",
      [dev.id, game.id],
    );
    await expect(t.admin(
      "insert into connect_jobs (user_id, game_id, installation_id, repo, features, status) values ($1, $2, 1, 'dev/game', array['badges'], 'done')",
      [dev.id, game.id],
    )).rejects.toThrow();
  });
});
