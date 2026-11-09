import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let dev2: { id: string };
let player: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  dev2 = await t.user("creator");
  player = await t.user();
}, 60_000);

describe("AI status", () => {
  it("tells everyone which AI is on", async () => {
    await t.admin("update ai_settings set enabled = false, free_enabled = true, free_base_url = 'https://free.example/api', free_model = 'qwen'");
    expect(await t.as(null, "select ai_status() as s")).toEqual([{ s: { free: true, strong: false } }]);
    await t.admin("update ai_settings set free_enabled = false");
    expect(await t.as(player, "select ai_status() as s")).toEqual([{ s: { free: false, strong: false } }]);
  });
});

describe("game helper", () => {
  it("is set up by the server; only the game's developer and admins see what it knows", async () => {
    const game = await t.game(dev);
    await t.service("insert into game_help (game_id, notes, guide) values ($1, 'Hold Shift to run', 'Goal: reach the flag')", [game.id]);
    expect(await t.as(dev, "select notes from game_help")).toEqual([{ notes: "Hold Shift to run" }]);
    expect(await t.as(admin, "select notes from game_help where game_id = $1", [game.id])).toHaveLength(1);
    expect(await t.as(dev2, "select notes from game_help")).toEqual([]);
    expect(await t.as(player, "select notes from game_help")).toEqual([]);
    await expect(t.as(null, "select notes from game_help")).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "update game_help set notes = 'x'")).rejects.toThrow(/permission denied/);
    await t.admin("delete from games where id = $1", [game.id]);
    expect(await t.service("select * from game_help where game_id = $1", [game.id])).toEqual([]);
  });

  it("lets players ask and developers learn, each only so often an hour", async () => {
    await t.admin("delete from ai_free_limits");
    await t.admin("update ai_settings set free_enabled = true");
    for (let i = 0; i < 40; i++) await t.service("select ai_free_take($1, 'help')", [player.id]);
    await expect(t.service("select ai_free_take($1, 'help')", [player.id])).rejects.toThrow(/rate_limited/);
    await expect(t.service("select ai_free_take($1, 'learn')", [player.id])).rejects.toThrow(/not_allowed/);
    await t.service("select ai_free_take($1, 'learn')", [dev.id]);
  });
});
