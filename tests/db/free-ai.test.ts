import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let player: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  player = await t.user();
}, 60_000);

beforeEach(async () => {
  await t.admin("delete from ai_free_limits");
  await t.admin("delete from ai_free_usage");
  await t.admin("delete from connect_jobs");
  await t.admin("update ai_settings set free_enabled = true, free_base_url = 'https://free.example/api', free_model = 'qwen'");
});

const take = (who: { id: string }, feature: string) => t.service("select ai_free_take($1, $2)", [who.id, feature]);

describe("free AI settings", () => {
  it("can't be turned on without an endpoint and a model, and need https", async () => {
    await expect(t.as(admin, "update ai_settings set free_model = ''")).rejects.toThrow(/check/);
    await expect(t.as(admin, "update ai_settings set free_base_url = 'http://insecure.example'")).rejects.toThrow(/check/);
    await t.as(admin, "update ai_settings set free_enabled = false, free_model = ''");
  });

  it("are changed by admins only, and anyone can see whether they're on", async () => {
    expect(await t.as(dev, "update ai_settings set free_enabled = false returning id")).toEqual([]);
    expect(await t.as(null, "select ai_free_on() as on")).toEqual([{ on: true }]);
    await t.as(admin, "update ai_settings set free_enabled = false");
    expect(await t.as(player, "select ai_free_on() as on")).toEqual([{ on: false }]);
  });

  it("need no prices", async () => {
    await t.as(admin, "update ai_settings set enabled = false, input_price = 0, output_price = 0, free_enabled = true");
    expect(await t.as(null, "select ai_free_on() as on")).toEqual([{ on: true }]);
  });
});

describe("free AI limits", () => {
  it("let every account translate, but only so often an hour", async () => {
    for (let i = 0; i < 120; i++) await take(player, "translate");
    await expect(take(player, "translate")).rejects.toThrow(/rate_limited/);
    await take(dev, "translate"); // someone else's limit is separate
    await take(player, "similar"); // and so is another feature's
  });

  it("start again after an hour", async () => {
    for (let i = 0; i < 10; i++) await take(player, "suggest");
    await expect(take(player, "suggest")).rejects.toThrow(/rate_limited/);
    await t.admin("update ai_free_limits set window_start = now() - interval '61 minutes'");
    await take(player, "suggest");
  });

  it("keep developer features for developers, and the test for admins", async () => {
    for (const f of ["release", "describe", "summary", "connect"]) await expect(take(player, f)).rejects.toThrow(/not_allowed/);
    await take(dev, "release");
    await expect(take(dev, "test")).rejects.toThrow(/not_allowed/);
    await take(admin, "test");
    await expect(take(admin, "something-else")).rejects.toThrow(/not_allowed/);
  });

  it("stop everything when the free AI is off", async () => {
    await t.admin("update ai_settings set free_enabled = false");
    await expect(take(admin, "translate")).rejects.toThrow(/free_off/);
  });

  it("are for the server only", async () => {
    await expect(t.as(player, "select ai_free_take($1, 'translate')", [player.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "select * from ai_free_limits")).rejects.toThrow(/permission denied/);
  });
});

describe("free AI usage", () => {
  it("is counted per day and feature in one row, for admins to see", async () => {
    await t.service("select ai_free_record('translate', true, 100, 20)");
    await t.service("select ai_free_record('translate', false, 0, 0)");
    await t.service("select ai_free_record('similar', true, 50, 5)");
    const rows = await t.as<{ feature: string; calls: number; failed: number; input_tokens: number }>(admin, "select feature, calls, failed, input_tokens from ai_free_usage order by feature");
    expect(rows).toEqual([
      { feature: "similar", calls: 1, failed: 0, input_tokens: 50 },
      { feature: "translate", calls: 2, failed: 1, input_tokens: 100 },
    ]);
    expect(await t.as(dev, "select * from ai_free_usage")).toEqual([]);
    await expect(t.as(admin, "select ai_free_record('translate', true, 1, 1)")).rejects.toThrow(/permission denied/);
  });

  it("keeps saved translations and suggestions away from the pages", async () => {
    await expect(t.as(admin, "select * from ai_translations")).rejects.toThrow(/permission denied/);
    await expect(t.as(player, "select * from ai_suggestions")).rejects.toThrow(/permission denied/);
    await t.service("insert into ai_translations (kind, ref, lang, hash, text) values ('post', 'x', 'de', 'h', '[\"Hallo\"]')");
    await expect(t.service("insert into ai_translations (kind, ref, lang, hash, text) values ('nope', 'x', 'de', 'h', 't')")).rejects.toThrow(/check/);
  });
});

describe("bug fix runs", () => {
  it("can be started for a bug report, with the fix feature alone", async () => {
    const game = await t.game(dev);
    const [post] = await t.as<{ id: string }>(player, "insert into feedback_posts (game_id, kind, title) values ($1, 'bug', 'Jump is broken') returning id", [game.id]);
    const [job] = await t.service<{ id: string }>(
      "insert into connect_jobs (user_id, installation_id, repo, features, game_id, feedback_id) values ($1, 7, 'me/game', '{fix}', $2, $3) returning id",
      [dev.id, game.id, post.id],
    );
    expect(await t.as(dev, "select features, feedback_id from connect_jobs where id = $1", [job.id])).toEqual([{ features: ["fix"], feedback_id: post.id }]);
    await t.admin("delete from connect_jobs");
    await expect(t.service("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'me/game', '{fix,saves}')", [dev.id])).rejects.toThrow(/check/);
    await expect(t.service("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'me/game', '{other}')", [dev.id])).rejects.toThrow(/check/);
    await t.service("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'me/game', '{saves,scores}')", [dev.id]);
  });
});
