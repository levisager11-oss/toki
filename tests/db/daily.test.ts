import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
}, 60_000);

const rpc = async <T = unknown>(who: Who, fn: string, args: unknown[] = [], types: string[] = []) => {
  const params = args.map((_, i) => `$${i + 1}${types[i] ? `::${types[i]}` : ""}`).join(", ");
  const rows = await t.as<Record<string, T>>(who, `select ${fn}(${params}) as r`, args);
  return rows[0]?.r as T;
};
type Submit = { best: number; new: boolean; week: number; week_new: boolean; day: number | null; day_new: boolean; daily: boolean; bar: number };
const submit = (who: Who, game: { id: string }, score: number) => rpc<Submit>(who, "submit_score", [game.id, score], ["uuid", "bigint"]);
const play = (who: Who, game: { id: string }) => rpc(who, "record_play", [game.id, crypto.randomUUID()], ["uuid", "uuid"]);
/** Makes Today's game this game (as an admin would). */
const makeDaily = (game: { id: string }) => t.as(admin, "select set_daily_game(utc_today(), $1::uuid)", [game.id]);
const board = async (who: Who, game: { id: string }, period: "day" | "week") =>
  (await t.as<{ rank: string; user_id: string; score: string }>(who, "select rank, user_id, score from period_leaderboard($1, $2)", [game.id, period]))
    .map((r) => [Number(r.rank), r.user_id, Number(r.score)]);
const pickFor = async (day: string) => (await t.admin<{ g: string | null }>("select daily_game_for($1::date) as g", [day]))[0].g;
type Daily = {
  day: string; game_id: string; players: number;
  top: { rank: number; user_id: string; score: number }[];
  streak: { streak: number; best_streak: number; last_day: string } | null;
} | null;
const today = async () => (await t.admin<{ d: string }>("select utc_today()::text as d"))[0].d;

describe("today's game", () => {
  it("is nothing while no game has high scores", async () => {
    await t.game(dev);
    expect(await rpc<Daily>(null, "daily_today")).toBeNull();
    expect(await pickFor("2020-01-01")).toBeNull();
  });

  it("is picked from games with high scores, once per day, and never twice in a row", async () => {
    const p = await t.user();
    const scored = [await t.game(dev), await t.game(dev), await t.game(dev)];
    for (const g of scored) await submit(p, g, 10);
    const ids = scored.map((g) => g.id);
    // A day in the past, so today's game stays free for the other tests.
    let before: string | null = null;
    for (let d = 1; d <= 28; d++) {
      const day = `2020-02-${String(d).padStart(2, "0")}`;
      const g = await pickFor(day);
      expect(ids).toContain(g);
      expect(g).not.toBe(before);
      // Asked again: the same game.
      expect(await pickFor(day)).toBe(g);
      before = g;
    }
    // It doesn't change during the day when another game gets its first score.
    const first = await pickFor("2020-02-01");
    await submit(p, await t.game(dev), 5);
    expect(await pickFor("2020-02-01")).toBe(first);
  });

  it("shows on the home page for everyone", async () => {
    const d = await rpc<Daily>(null, "daily_today");
    expect(d?.day).toBe(await today());
    expect(d?.game_id).toBeTruthy();
    expect(d?.streak).toBeNull();
    // Same game for a logged-in player.
    expect((await rpc<Daily>(await t.user(), "daily_today"))?.game_id).toBe(d?.game_id);
  });

  it("can be chosen by admins only, for today or later", async () => {
    const g = await t.game(dev);
    const player = await t.user();
    await expect(t.as(player, "select set_daily_game(utc_today(), $1::uuid)", [g.id])).rejects.toThrow(/not_allowed/);
    await expect(t.as(dev, "select set_daily_game(utc_today() + 1, $1::uuid)", [g.id])).rejects.toThrow(/not_allowed/);
    await expect(t.as(null, "select set_daily_game(utc_today() + 1, $1::uuid)", [g.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "select set_daily_game(utc_today() - 1, $1::uuid)", [g.id])).rejects.toThrow(/bad_day/);
    await expect(t.as(admin, "select set_daily_game(utc_today() + 1, $1::uuid)", [crypto.randomUUID()])).rejects.toThrow(/not_found/);

    await makeDaily(g);
    expect((await rpc<Daily>(null, "daily_today"))?.game_id).toBe(g.id);
    await t.as(admin, "select set_daily_game(utc_today() + 3, $1::uuid)", [g.id]);
    const plan = await t.as<{ day: string; game_id: string; chosen: boolean }>(admin, "select day::text, game_id, chosen from daily_schedule()");
    expect(plan.map((r) => [r.game_id, r.chosen])).toEqual([[g.id, true], [g.id, true]]);
    expect(await t.as(player, "select * from daily_schedule()")).toEqual([]);
    // Back to automatic.
    await t.as(admin, "select set_daily_game(utc_today() + 3, null)");
    expect(await t.as(admin, "select * from daily_schedule()")).toHaveLength(1);
  });

  it("is only read and changed through its functions", async () => {
    const p = await t.user();
    await expect(t.as(p, "select * from daily_games")).rejects.toThrow(/permission denied/);
    await expect(t.as(null, "select daily_game_for(current_date + 5)")).rejects.toThrow(/permission denied/);
    await expect(t.as(p, "select daily_game_for(current_date + 5)")).rejects.toThrow(/permission denied/);
  });
});

describe("this week's best", () => {
  it("keeps each player's best of the week, even below their best of all time", async () => {
    const g = await t.game(dev);
    const a = await t.user(), b = await t.user();
    expect(await submit(a, g, 100)).toMatchObject({ best: 100, new: true, week: 100, week_new: true });
    expect(await submit(b, g, 80)).toMatchObject({ week: 80, week_new: true });
    // Last week now.
    await t.admin("update period_scores set since = since - 7 where game_id = $1", [g.id]);
    expect(await board(null, g, "week")).toEqual([]);
    // A new week: a lower score counts for the week, but not for all time.
    expect(await submit(a, g, 50)).toMatchObject({ best: 100, new: false, week: 50, week_new: true, bar: 50 });
    expect(await submit(a, g, 40)).toMatchObject({ week: 50, week_new: false });
    expect(await submit(b, g, 70)).toMatchObject({ week: 70, week_new: true });
    expect(await board(null, g, "week")).toEqual([[1, b.id, 70], [2, a.id, 50]]);
    // The all-time list is as before.
    const all = await t.as<{ user_id: string }>(null, "select user_id from leaderboard($1)", [g.id]);
    expect(all.map((r) => r.user_id)).toEqual([a.id, b.id]);
  });

  it("follows the game's order (lower is better)", async () => {
    const g = await t.game(dev);
    await t.admin("update games set score_order = 'low' where id = $1", [g.id]);
    const a = await t.user(), b = await t.user();
    await submit(a, g, 3000);
    await submit(b, g, 2000);
    expect(await submit(a, g, 3500)).toMatchObject({ week: 3000, week_new: false });
    expect(await submit(a, g, 1500)).toMatchObject({ week: 1500, week_new: true, best: 1500, new: true });
    expect(await board(null, g, "week")).toEqual([[1, a.id, 1500], [2, b.id, 2000]]);
  });

  it("shows the top and the player's own place", async () => {
    const g = await t.game(dev);
    const players = [];
    for (let i = 0; i < 12; i++) {
      const p = await t.user();
      players.push(p);
      await submit(p, g, 100 - i);
    }
    expect(await board(null, g, "week")).toHaveLength(10);
    const mine = await board(players[11], g, "week");
    expect(mine).toHaveLength(11);
    expect(mine.at(-1)).toEqual([12, players[11].id, 89]);
  });

  it("needs an account to get on, and can't be read or written directly", async () => {
    const g = await t.game(dev);
    const a = await t.user();
    await expect(submit(null, g, 5)).rejects.toThrow(/permission denied|login_required/);
    await expect(t.as(a, "select * from period_scores")).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "insert into period_scores (game_id, user_id, period, since, score) values ($1, $2, 'week', current_date, 9)", [g.id, a.id])).rejects.toThrow(/permission denied/);
  });

  it("loses a score the developer removes", async () => {
    const g = await t.game(dev);
    const a = await t.user();
    await makeDaily(g);
    await submit(a, g, 30);
    expect(await board(null, g, "day")).toHaveLength(1);
    await t.as(dev, "delete from game_scores where game_id = $1 and user_id = $2", [g.id, a.id]);
    expect(await board(null, g, "week")).toEqual([]);
    expect(await board(null, g, "day")).toEqual([]);
  });
});

describe("today's list", () => {
  it("only has today's scores on Today's game", async () => {
    const daily = await t.game(dev), other = await t.game(dev);
    await makeDaily(daily);
    const a = await t.user(), b = await t.user();
    expect(await submit(a, other, 10)).toMatchObject({ daily: false, day: null, day_new: false, bar: 10 });
    expect(await board(null, other, "day")).toEqual([]);

    expect(await submit(a, daily, 10)).toMatchObject({ daily: true, day: 10, day_new: true, bar: 10 });
    await submit(b, daily, 20);
    // Yesterday's scores don't count today.
    await t.admin("update period_scores set since = since - 1 where game_id = $1 and period = 'day'", [daily.id]);
    expect(await board(null, daily, "day")).toEqual([]);
    expect(await submit(a, daily, 5)).toMatchObject({ best: 10, new: false, week: 10, day: 5, day_new: true, bar: 5 });
    expect(await board(null, daily, "day")).toEqual([[1, a.id, 5]]);
  });

  it("shows the top 3 and the player's own place on the card", async () => {
    const g = await t.game(dev);
    await makeDaily(g);
    const ps = [];
    for (let i = 0; i < 5; i++) {
      const p = await t.user();
      ps.push(p);
      await submit(p, g, 50 + i);
    }
    const guest = await rpc<Daily>(null, "daily_today");
    expect(guest?.game_id).toBe(g.id);
    expect(guest?.players).toBe(5);
    expect(guest?.top.map((r) => [r.rank, r.user_id, r.score])).toEqual([[1, ps[4].id, 54], [2, ps[3].id, 53], [3, ps[2].id, 52]]);
    const last = await rpc<Daily>(ps[0], "daily_today");
    expect(last?.top.at(-1)).toMatchObject({ rank: 5, user_id: ps[0].id, score: 50 });
  });
});

describe("streaks", () => {
  const streak = async (who: { id: string }) =>
    (await t.admin<{ streak: number; best_streak: number; last_day: string }>("select streak, best_streak, last_day::text from daily_streaks where user_id = $1", [who.id]))[0];

  it("count days in a row of playing Today's game", async () => {
    const daily = await t.game(dev), other = await t.game(dev);
    await makeDaily(daily);
    const p = await t.user();
    await play(p, other);
    expect(await streak(p)).toBeUndefined();

    await play(p, daily);
    expect(await streak(p)).toEqual({ streak: 1, best_streak: 1, last_day: await today() });
    // Once a day.
    await play(p, daily);
    expect((await streak(p)).streak).toBe(1);

    // Played yesterday: one more.
    await t.admin("update daily_streaks set last_day = last_day - 1 where user_id = $1", [p.id]);
    await play(p, daily);
    expect(await streak(p)).toMatchObject({ streak: 2, best_streak: 2 });
    await t.admin("update daily_streaks set last_day = last_day - 1, streak = 6, best_streak = 6 where user_id = $1", [p.id]);
    await play(p, daily);
    expect(await streak(p)).toMatchObject({ streak: 7, best_streak: 7 });

    // A day missed: it starts again, the best stays.
    await t.admin("update daily_streaks set last_day = last_day - 2 where user_id = $1", [p.id]);
    await play(p, daily);
    expect(await streak(p)).toMatchObject({ streak: 1, best_streak: 7 });

    expect((await rpc<Daily>(p, "daily_today"))?.streak).toMatchObject({ streak: 1, best_streak: 7 });
  });

  it("need an account, are public to read, and only change by playing", async () => {
    const daily = await t.game(dev);
    await makeDaily(daily);
    await play(null, daily);
    const p = await t.user();
    await play(p, daily);
    expect(await t.as(null, "select streak from daily_streaks where user_id = $1", [p.id])).toEqual([{ streak: 1 }]);
    await expect(t.as(p, "update daily_streaks set streak = 99 where user_id = $1", [p.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(p, "insert into daily_streaks (user_id, streak, best_streak, last_day) values ($1, 9, 9, current_date)", [crypto.randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(t.as(p, "select count_daily_play($1, $2)", [p.id, daily.id])).rejects.toThrow(/permission denied/);
  });
});

describe("weeks", () => {
  it("start on Monday", async () => {
    const rows = await t.admin<{ a: string; b: string; c: string }>(
      "select week_start('2026-11-23')::text a, week_start('2026-11-29')::text b, week_start('2026-11-30')::text c",
    );
    expect(rows[0]).toEqual({ a: "2026-11-23", b: "2026-11-23", c: "2026-11-30" });
  });
});
