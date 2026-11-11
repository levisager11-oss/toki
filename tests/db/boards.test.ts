import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let dev: { id: string };
let otherDev: { id: string };
let admin: { id: string };

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  admin = await t.user("admin");
}, 60_000);

type Result = { best: number; new: boolean; week: number; week_new: boolean; day: number | null; day_new: boolean; daily: boolean; bar: number; board?: string } | null;
const one = async <T>(who: Who, sql: string, params: unknown[]) => (await t.as<{ r: T }>(who, sql, params))[0].r;
const set = (who: Who, g: string, list: unknown, mode = "replace") => one<number>(who, "select public.set_boards($1, $2::jsonb, $3) as r", [g, JSON.stringify(list), mode]);
const submit = (who: Who, g: string, score: number, board?: string) =>
  board === undefined
    ? one<Result>(who, "select public.submit_score($1::uuid, $2::bigint) as r", [g, score])
    : one<Result>(who, "select public.submit_score($1::uuid, $2::bigint, $3::text) as r", [g, score, board]);
const top = async (who: Who, g: string, board?: string) =>
  (await t.as<{ rank: string; user_id: string; score: string }>(
    who,
    board === undefined ? "select rank, user_id, score from leaderboard($1)" : "select rank, user_id, score from leaderboard($1, 10, $2)",
    board === undefined ? [g] : [g, board],
  )).map((r) => [Number(r.rank), r.user_id, Number(r.score)]);
const week = async (who: Who, g: string, board: string) =>
  (await t.as<{ rank: string; user_id: string; score: string }>(who, "select rank, user_id, score from period_leaderboard($1, 'week', 10, $2)", [g, board]))
    .map((r) => [Number(r.rank), r.user_id, Number(r.score)]);
const boards = (g: string) => t.as<{ id: string; name: string; name_de: string | null; score_order: string; score_format: string }>(
  null, "select id, name, name_de, score_order, score_format from game_boards where game_id = $1 order by position, id", [g]);

const LIST = [
  { id: "", name: "Classic", name_de: "Klassisch" },
  { id: "hard", name: "Hard mode", name_de: "Schwer" },
  { id: "speedrun", name: "Speedrun", score_order: "low", score_format: "time" },
];

describe("defining boards", () => {
  it("lets the game's developer set them, in order, and name the main board", async () => {
    const g = await t.game(dev);
    expect(await set(dev, g.id, LIST)).toBe(2);
    expect(await boards(g.id)).toEqual([
      { id: "hard", name: "Hard mode", name_de: "Schwer", score_order: "high", score_format: "points" },
      { id: "speedrun", name: "Speedrun", name_de: null, score_order: "low", score_format: "time" },
    ]);
    expect(await t.admin("select board_name, board_name_de from games where id = $1", [g.id])).toEqual([{ board_name: "Classic", board_name_de: "Klassisch" }]);
    // An empty name: "Main" again.
    await set(dev, g.id, [{ id: "", name: " " }, ...LIST.slice(1)]);
    expect(await t.admin("select board_name from games where id = $1", [g.id])).toEqual([{ board_name: null }]);
  });

  it("is only for the game's developer, admins and the server", async () => {
    const g = await t.game(dev);
    for (const who of [otherDev, await t.user(), null]) await expect(set(who, g.id, LIST)).rejects.toThrow();
    expect(await set(admin, g.id, [{ id: "a", name: "A" }])).toBe(1);
    expect(await t.service<{ n: number }>("select public.set_boards($1, $2::jsonb, 'merge') as n", [g.id, JSON.stringify([{ id: "b", name: "B" }])])).toEqual([{ n: 2 }]);
    await expect(t.as(dev, "insert into game_boards (game_id, id, name) values ($1, 'x', 'X')", [g.id])).rejects.toThrow();
    await expect(t.as(dev, "update game_boards set name = 'Y' where game_id = $1", [g.id])).rejects.toThrow();
  });

  it("refuses bad lists, and more than 10 boards", async () => {
    const g = await t.game(dev);
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, name: `B ${i}` }));
    await expect(set(dev, g.id, many)).rejects.toThrow(/too_many_boards/);
    // The main board's name doesn't count.
    expect(await set(dev, g.id, [{ id: "", name: "Normal" }, ...many.slice(0, 10)])).toBe(10);
    for (const bad of [
      [{ id: "bad id", name: "X" }], [{ id: "a", name: "A" }, { id: "a", name: "B" }], [{ id: "a", name: "" }], [{ name: "No id" }],
      [{ id: "a", name: "A", score_order: "up" }], [{ id: "a", name: "A", score_format: "meters" }], [{ id: "", name: "A" }, { id: "", name: "B" }],
      [{ id: "a", name: "x".repeat(41) }], "nope",
    ]) await expect(set(dev, g.id, bad)).rejects.toThrow(/bad_boards/);
    await expect(set(dev, g.id, [], "delete")).rejects.toThrow(/bad_boards/);
    expect(await boards(g.id)).toHaveLength(10);
  });

  it("merges from toki.json without deleting, and only adds what Toki Connect proposes", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    // merge: updates the listed ones (keeping the order it doesn't mention), adds new ones
    const server = (list: unknown, mode: string) => t.service<{ n: number }>("select public.set_boards($1, $2::jsonb, $3) as n", [g.id, JSON.stringify(list), mode]).then((r) => r[0].n);
    await expect(set(null, g.id, [{ id: "zen", name: "Zen" }], "merge")).rejects.toThrow(/permission denied/);
    expect(await server([{ id: "hard", name: "Very hard" }, { id: "zen", name: "Zen" }], "merge")).toBe(3);
    expect((await boards(g.id)).map((b) => [b.id, b.name, b.score_order])).toEqual([["hard", "Very hard", "high"], ["zen", "Zen", "high"], ["speedrun", "Speedrun", "low"]]);
    // add: new ones only, after the others; the main board keeps its name
    expect(await server([{ id: "", name: "Other" }, { id: "hard", name: "Changed" }, { id: "daily-run", name: "Daily run" }], "add")).toBe(4);
    expect((await boards(g.id)).map((b) => [b.id, b.name])).toEqual([["hard", "Very hard"], ["zen", "Zen"], ["speedrun", "Speedrun"], ["daily-run", "Daily run"]]);
    expect(await t.admin("select board_name from games where id = $1", [g.id])).toEqual([{ board_name: "Classic" }]);
    // as many as fit
    const more = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, name: `M ${i}` }));
    expect(await server(more, "add")).toBe(10);
    expect(await server(more, "merge")).toBe(10);
  });
});

describe("scores on boards", () => {
  it("keeps the old way of sending working: the main board", async () => {
    const g = await t.game(dev);
    const p = await t.user();
    expect(await submit(p, g.id, 100)).toMatchObject({ best: 100, new: true, week: 100, board: "" });
    expect(await submit(p, g.id, 90)).toMatchObject({ best: 100, new: false });
    expect(await submit(p, g.id, 120, "")).toMatchObject({ best: 120, new: true });
    expect(await top(null, g.id)).toEqual([[1, p.id, 120]]);
    expect(await top(null, g.id, "")).toEqual([[1, p.id, 120]]);
  });

  it("keeps a best per board, each in its own order", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    const a = await t.user(), b = await t.user();
    await submit(a, g.id, 500);
    expect(await submit(a, g.id, 50, "hard")).toMatchObject({ best: 50, new: true, board: "hard", daily: false, day: null });
    expect(await submit(b, g.id, 70, "hard")).toMatchObject({ best: 70, new: true });
    // lower is better on the speedrun board
    expect(await submit(a, g.id, 61_000, "speedrun")).toMatchObject({ best: 61_000, new: true });
    expect(await submit(a, g.id, 65_000, "speedrun")).toMatchObject({ best: 61_000, new: false });
    expect(await submit(b, g.id, 59_000, "speedrun")).toMatchObject({ best: 59_000, new: true });
    expect(await top(null, g.id, "hard")).toEqual([[1, b.id, 70], [2, a.id, 50]]);
    expect(await top(null, g.id, "speedrun")).toEqual([[1, b.id, 59_000], [2, a.id, 61_000]]);
    // the main board is as it was
    expect(await top(null, g.id)).toEqual([[1, a.id, 500]]);
    // and the profile says which board
    const mine = await t.as<{ board: string; board_name: string | null; rank: string; players: string; has_boards: boolean }>(
      null, "select board, board_name, rank, players, has_boards from player_scores($1) where game_id = $2 order by board", [a.id, g.id]);
    expect(mine.map((r) => [r.board, r.board_name, Number(r.rank), Number(r.players), r.has_boards])).toEqual([
      ["", "Classic", 1, 1, true], ["hard", "Hard mode", 2, 2, true], ["speedrun", "Speedrun", 2, 2, true],
    ]);
  });

  it("ignores boards the game doesn't have", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    const p = await t.user();
    expect(await submit(p, g.id, 10, "nope")).toBeNull();
    expect(await submit(p, g.id, 10, "bad id!")).toBeNull();
    // another game's board doesn't count either
    const other = await t.game(dev);
    expect(await submit(p, other.id, 10, "hard")).toBeNull();
    expect(await t.admin("select count(*)::int as n from game_scores where user_id = $1", [p.id])).toEqual([{ n: 0 }]);
    await expect(submit(null, g.id, 10, "hard")).rejects.toThrow(/permission denied|login_required/);
    await expect(t.as(p, "insert into game_scores (game_id, board, user_id, score) values ($1, 'hard', $2, 5)", [g.id, p.id])).rejects.toThrow(/permission denied/);
  });

  it("has this week's list per board, and today's only on the main board", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    await t.as(admin, "select set_daily_game(utc_today(), $1::uuid)", [g.id]);
    const a = await t.user(), b = await t.user();
    expect(await submit(a, g.id, 30, "hard")).toMatchObject({ week: 30, week_new: true, daily: false, day: null, bar: 30 });
    expect(await submit(b, g.id, 40, "hard")).toMatchObject({ week: 40, week_new: true });
    expect(await submit(a, g.id, 7)).toMatchObject({ daily: true, day: 7, day_new: true });
    expect(await week(null, g.id, "hard")).toEqual([[1, b.id, 40], [2, a.id, 30]]);
    expect(await week(null, g.id, "")).toEqual([[1, a.id, 7]]);
    // the old call is the main board
    const old = await t.as<{ user_id: string }>(null, "select user_id from period_leaderboard($1, 'week')", [g.id]);
    expect(old.map((r) => r.user_id)).toEqual([a.id]);
    const day = await t.as<{ user_id: string }>(null, "select user_id from period_leaderboard($1, 'day', 10, 'hard')", [g.id]);
    expect(day).toEqual([]);
    // Today's card counts the main board only.
    expect(await one<{ players: number }>(null, "select daily_today() as r", [])).toMatchObject({ game_id: g.id, players: 1 });
    // A new week starts over on every board.
    await t.admin("update period_scores set since = since - 7 where game_id = $1 and period = 'week'", [g.id]);
    expect(await week(null, g.id, "hard")).toEqual([]);
    expect(await submit(b, g.id, 20, "hard")).toMatchObject({ best: 40, new: false, week: 20, week_new: true });
    await t.as(admin, "select set_daily_game(utc_today(), null)");
  });

  it("tells whoever drops out of a board's top 3, with the board's name", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    const players = [await t.user(), await t.user(), await t.user()];
    for (const [i, p] of players.entries()) await submit(p, g.id, 10 + i, "hard");
    const late = await t.user();
    await submit(late, g.id, 99, "hard");
    const notes = await t.admin<{ user_id: string; data: Record<string, string> }>(
      "select user_id, data from notifications where kind = 'score_beaten' and data->>'game' = $1", [g.id]);
    expect(notes.map((n) => n.user_id)).toEqual([players[0].id]);
    expect(notes[0].data).toMatchObject({ board: "hard", board_name: "Hard mode", board_name_de: "Schwer" });
    // The main board's notifications have no board.
    for (const [i, p] of players.entries()) await submit(p, g.id, 10 + i);
    await submit(late, g.id, 99);
    const main = await t.admin<{ data: Record<string, string> }>(
      "select data from notifications where kind = 'score_beaten' and data->>'game' = $1 and not data ? 'board'", [g.id]);
    expect(main).toHaveLength(1);
  });

  it("lets the developer remove a score on one board only", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    const p = await t.user();
    await submit(p, g.id, 10);
    await submit(p, g.id, 20, "hard");
    // Others can't.
    await t.as(otherDev, "delete from game_scores where game_id = $1 and user_id = $2 and board = 'hard'", [g.id, p.id]);
    expect(await top(null, g.id, "hard")).toHaveLength(1);
    await t.as(dev, "delete from game_scores where game_id = $1 and user_id = $2 and board = 'hard'", [g.id, p.id]);
    expect(await top(null, g.id, "hard")).toEqual([]);
    expect(await week(null, g.id, "hard")).toEqual([]);
    expect(await top(null, g.id)).toEqual([[1, p.id, 10]]);
    expect(await week(null, g.id, "")).toEqual([[1, p.id, 10]]);
  });

  it("deletes a board's scores with the board", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    const p = await t.user();
    await submit(p, g.id, 10);
    await submit(p, g.id, 20, "hard");
    await submit(p, g.id, 30_000, "speedrun");
    // Removed in the form: its scores go; the others stay.
    await set(dev, g.id, [LIST[0], LIST[2]]);
    expect(await t.admin<{ board: string }>("select board from game_scores where game_id = $1 order by board", [g.id])).toEqual([{ board: "" }, { board: "speedrun" }]);
    expect(await t.admin<{ board: string }>("select distinct board from period_scores where game_id = $1 order by board", [g.id])).toEqual([{ board: "" }, { board: "speedrun" }]);
    // Sending to it now is ignored.
    expect(await submit(p, g.id, 50, "hard")).toBeNull();
  });

  it("counts scores per board on the stats page", async () => {
    const g = await t.game(dev);
    await set(dev, g.id, LIST);
    await submit(await t.user(), g.id, 1);
    await submit(await t.user(), g.id, 2, "hard");
    await submit(await t.user(), g.id, 3, "hard");
    const a = await one<{ scores: number; boards: { id: string; scores: number }[] }>(dev, "select game_analytics($1) as r", [g.id]);
    expect(a.scores).toBe(1);
    expect(a.boards.map((b) => [b.id, b.scores])).toEqual([["hard", 2], ["speedrun", 0]]);
  });
});

describe("Toki Connect", () => {
  it("can add boards", async () => {
    const p = await t.user("creator");
    await t.admin("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'dev/game', array['saves', 'scores', 'multiplayer', 'achievements', 'boards'])", [p.id]);
    await expect(t.admin("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'dev/game', array['ladders'])", [p.id])).rejects.toThrow();
  });
});
