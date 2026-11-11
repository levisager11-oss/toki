import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let dev: { id: string };
let otherDev: { id: string };
let player: { id: string };
let devGame: { id: string };
let otherGame: { id: string };

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  player = await t.user();
  devGame = await t.game(dev);
  otherGame = await t.game(otherDev);
}, 60_000);

const mark = (who: Who, game: string, topic = "name") =>
  t.as(who, "insert into game_update_marks (game_id, topic) values ($1, $2)", [game, topic]);
const marks = (who: Who) => t.as<{ game_id: string; topic: string }>(who, "select game_id, topic from game_update_marks order by topic");
const stored = (game: string) => t.admin<{ topic: string }>("select topic from game_update_marks where game_id = $1 order by topic", [game]);

describe("marking an update as already done", () => {
  it("lets developers mark their own games and see the marks", async () => {
    await mark(dev, devGame.id, "host");
    await mark(dev, devGame.id, "name");
    expect(await marks(dev)).toEqual([{ game_id: devGame.id, topic: "host" }, { game_id: devGame.id, topic: "name" }]);
  });

  it("keeps one mark per game and update", async () => {
    await expect(mark(dev, devGame.id, "name")).rejects.toThrow();
  });

  it("doesn't let anyone mark or see other developers' games", async () => {
    for (const who of [dev, player, null]) await expect(mark(who, otherGame.id)).rejects.toThrow();
    expect(await stored(otherGame.id)).toEqual([]);
    await mark(otherDev, otherGame.id);
    expect((await marks(dev)).map((m) => m.game_id)).not.toContain(otherGame.id);
    expect(await marks(player)).toEqual([]);
    await expect(marks(null)).rejects.toThrow();
  });

  it("only takes update topics", async () => {
    for (const topic of ["", "Name", "a b", "x".repeat(31)]) await expect(mark(dev, devGame.id, topic)).rejects.toThrow();
  });

  it("lets only the developer take a mark back", async () => {
    await t.as(otherDev, "delete from game_update_marks where game_id = $1", [devGame.id]);
    await t.as(player, "delete from game_update_marks where game_id = $1", [devGame.id]);
    expect(await stored(devGame.id)).toEqual([{ topic: "host" }, { topic: "name" }]);
    await t.as(dev, "delete from game_update_marks where game_id = $1 and topic = 'host'", [devGame.id]);
    expect(await stored(devGame.id)).toEqual([{ topic: "name" }]);
  });

  it("goes with the game", async () => {
    await t.admin("delete from games where id = $1", [devGame.id]);
    expect(await stored(devGame.id)).toEqual([]);
  });
});
