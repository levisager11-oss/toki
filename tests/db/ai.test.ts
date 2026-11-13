import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

// Prices: $1 per million input tokens, $2 per million output tokens. Cap $20, quota $5.
beforeEach(async () => {
  await t.admin("delete from ai_usage");
  await t.admin("delete from ai_quotas");
  await t.admin("delete from connect_jobs");
  await t.admin("delete from ai_free_limits");
  await t.admin("update ai_settings set enabled = true, base_url = '', monthly_cap = 20, default_quota = 5");
  await t.admin("update ai_features set model = 'test-model', input_price = 1, output_price = 2, thinking = 'default'");
});

const M = 1_000_000;
type Reservation = { id: number; provider: string; base_url: string; model: string; max_cost: number };
const reserve = (user: { id: string }, input: number, output: number, feature = "connect") =>
  t.service<{ r: Reservation }>("select ai_reserve($1, $2, null, $3, $4) as r", [user.id, feature, input, output]).then((r) => r[0].r);
const settle = (id: number, input: number, output: number, ok = true) =>
  t.service<{ c: string | null }>("select ai_settle($1, $2, $3, $4) as c", [id, input, output, ok]).then((r) => (r[0].c === null ? null : Number(r[0].c)));
const budget = (who: { id: string }) => t.as<{ b: { enabled: boolean; spent: number; quota: number | null; cap_reached: boolean } }>(who, "select my_ai_budget() as b").then((r) => r[0].b);

describe("settings", () => {
  it("are only visible to and changeable by admins", async () => {
    expect(await t.as(admin, "select default_quota from ai_settings")).toEqual([{ default_quota: "5.00" }]);
    expect(await t.as(dev, "select default_quota from ai_settings")).toEqual([]);
    expect(await t.as(player, "select default_quota from ai_settings")).toEqual([]);
    await expect(t.as(null, "select default_quota from ai_settings")).rejects.toThrow(/permission denied/);
    expect(await t.as(dev, "update ai_settings set monthly_cap = 999 returning id")).toEqual([]);
    const [s] = await t.as<{ monthly_cap: string; updated_by: string }>(admin, "update ai_settings set monthly_cap = 15 returning monthly_cap, updated_by");
    expect(s).toEqual({ monthly_cap: "15.00", updated_by: admin.id });
  });

  it("need prices for every feature with a model, and an https address", async () => {
    await expect(t.as(admin, "update ai_features set input_price = 0 where feature = 'translate'")).rejects.toThrow(/check/);
    await t.as(admin, "update ai_features set model = '', input_price = 0, output_price = 0 where feature = 'translate'");
    await expect(t.as(admin, "update ai_settings set base_url = 'http://insecure.example'")).rejects.toThrow(/check/);
    await expect(t.as(admin, "update ai_features set thinking = 'ultra' where feature = 'help'")).rejects.toThrow(/check/);
  });

  it("let only admins see and change the models per feature", async () => {
    expect(await t.as(dev, "select * from ai_features")).toEqual([]);
    expect(await t.as(dev, "update ai_features set model = 'x' returning feature")).toEqual([]);
    const rows = await t.as<{ feature: string }>(admin, "update ai_features set model = 'claude-haiku-5-5' where feature = 'summary' returning feature");
    expect(rows).toEqual([{ feature: "summary" }]);
    await expect(t.as(admin, "insert into ai_features (feature) values ('other')")).rejects.toThrow(/permission denied/);
  });

  it("are Anthropic only", async () => {
    await expect(t.as(admin, "update ai_settings set provider = 'openai_compatible'")).rejects.toThrow(/check/);
  });

  it("let admins choose the most tokens per step from a few steps", async () => {
    expect(await t.as(admin, "update ai_settings set max_output_tokens = 128000 returning max_output_tokens")).toEqual([{ max_output_tokens: 128000 }]);
    await expect(t.as(admin, "update ai_settings set max_output_tokens = 5")).rejects.toThrow(/check/);
    expect(await t.as(dev, "update ai_settings set max_output_tokens = 8000 returning id")).toEqual([]);
    await t.as(admin, "update ai_settings set max_output_tokens = 32000");
  });

  it("only let admins set quotas", async () => {
    await expect(t.as(dev, "insert into ai_quotas (user_id, monthly_usd) values ($1, 100)", [dev.id])).rejects.toThrow(/row-level security/);
    await t.as(admin, "insert into ai_quotas (user_id, monthly_usd) values ($1, 10)", [dev.id]);
    expect(await t.as(dev, "select * from ai_quotas")).toEqual([]);
  });
});

describe("spending limits", () => {
  it("reserves the highest possible cost and returns the settings to use", async () => {
    const r = await reserve(dev, M, M / 2);
    expect(r).toMatchObject({ provider: "anthropic", base_url: "", model: "test-model", thinking: "default" });
    expect(Number(r.max_cost)).toBe(2);
  });

  it("settles the real cost, once", async () => {
    const r = await reserve(dev, M, M);
    expect(await settle(r.id, M / 2, M / 4)).toBe(1);
    expect(await settle(r.id, M, M)).toBeNull();
    expect((await budget(dev)).spent).toBe(1);
  });

  it("stops a developer at their quota", async () => {
    await reserve(dev, M, M); // $3
    await expect(reserve(dev, M, M)).rejects.toThrow(/quota_reached/); // would be $6 > $5
    await reserve(dev, M, 0); // $4
    await reserve(dev2, M, M); // someone else's quota is separate
  });

  it("counts open reservations, so requests at the same time can't overspend", async () => {
    await reserve(dev, 0, 2 * M); // $4 reserved, not settled yet
    await expect(reserve(dev, 0, M)).rejects.toThrow(/quota_reached/);
  });

  it("uses a quota an admin set instead of the default", async () => {
    await t.as(admin, "insert into ai_quotas (user_id, monthly_usd) values ($1, 1)", [dev.id]);
    await expect(reserve(dev, M, M)).rejects.toThrow(/quota_reached/);
    await t.as(admin, "update ai_quotas set monthly_usd = 10 where user_id = $1", [dev.id]);
    await reserve(dev, 0, 4 * M); // $8
  });

  it("gives admins no quota, but the monthly cap stops everyone", async () => {
    await reserve(admin, 0, 9 * M); // $18, more than a developer's quota
    await expect(reserve(admin, 0, 1.5 * M)).rejects.toThrow(/cap_reached/); // $21 > $20
    await expect(reserve(dev, M, M)).rejects.toThrow(/cap_reached/); // $18 + $3 > $20
    await reserve(dev, 0, M / 2); // $19
  });

  it("keeps counting the cost of deleted accounts toward the cap", async () => {
    const gone = await t.user("creator");
    await reserve(gone, 0, 2 * M); // $4
    await t.admin("delete from auth.users where id = $1", [gone.id]);
    await t.admin("delete from profiles where id = $1", [gone.id]);
    expect(await t.admin("select user_id, cost from ai_usage")).toEqual([{ user_id: null, cost: "4.000000" }]);
    await reserve(admin, 0, 8 * M); // $16 + $4 = $20
    await expect(reserve(admin, 1, 0)).rejects.toThrow(/cap_reached/);
  });

  it("starts again each month", async () => {
    await t.admin("insert into ai_usage (user_id, feature, input_price, output_price, cost, status, created_at) values ($1, 'connect', 1, 2, 50, 'done', ai_month_start() - interval '1 day')", [dev.id]);
    await reserve(dev, M, M);
  });

  it("refuses when the AI is off, and developer features for players", async () => {
    await expect(reserve(player, 1, 1)).rejects.toThrow(/not_allowed/);
    for (const f of ["learn", "release", "describe", "summary", "connect_steps", "connect_quick"]) await expect(reserve(player, 1, 1, f)).rejects.toThrow(/not_allowed/);
    await expect(reserve(dev, 1, 1, "test")).rejects.toThrow(/not_allowed/);
    await t.admin("update ai_settings set enabled = false");
    await expect(reserve(dev, 1, 1)).rejects.toThrow(/ai_disabled/);
  });

  it("lets players translate, find similar feedback, get suggestions and ask the game helper", async () => {
    for (const f of ["translate", "similar", "suggest", "help"]) {
      const r = await reserve(player, 100, 100, f);
      expect(r.model).toBe("test-model");
    }
    // Players have no money quota, only Toki's cap and the calls per hour.
    expect((await t.admin<{ n: number }>("select count(*)::int as n from ai_usage where user_id = $1", [player.id]))[0].n).toBe(4);
  });

  it("uses each feature's own model and prices", async () => {
    await t.admin("update ai_features set model = 'claude-haiku-5-5', input_price = 0.1, output_price = 0.5 where feature = 'translate'");
    const r = await reserve(player, M, M, "translate");
    expect(r.model).toBe("claude-haiku-5-5");
    expect(Number(r.max_cost)).toBeCloseTo(0.6);
    expect((await reserve(dev, M, M)).model).toBe("test-model");
  });

  it("refuses a feature without a model", async () => {
    await t.admin("update ai_features set model = '', input_price = 0, output_price = 0 where feature = 'suggest'");
    await expect(reserve(player, 1, 1, "suggest")).rejects.toThrow(/ai_off/);
  });

  it("counts calls per hour per feature", async () => {
    await t.admin("update limits set player = 2 where key = 'ai_translate'");
    await reserve(player, 1, 1, "translate");
    await reserve(player, 1, 1, "translate");
    await expect(reserve(player, 1, 1, "translate")).rejects.toThrow(/rate_limited/);
    await reserve(player, 1, 1, "similar");
    await t.admin("update limits set player = 120 where key = 'ai_translate'");
  });

  it("tests a feature's model for admins", async () => {
    await t.admin("update ai_features set model = 'claude-haiku-5-5' where feature = 'help'");
    const r = await t.service<{ r: Reservation }>("select ai_reserve($1, 'test', null, 1, 1, 'help') as r", [admin.id]).then((x) => x[0].r);
    expect(r.model).toBe("claude-haiku-5-5");
  });

  it("can only be reserved and settled by the server", async () => {
    await expect(t.as(dev, "select ai_reserve($1, 'connect', null, 1, 1)", [dev.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "select ai_settle(1, 0, 0, true)")).rejects.toThrow(/permission denied/);
    await expect(t.as(null, "select ai_reserve($1, 'connect', null, 1, 1)", [dev.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "insert into ai_usage (user_id, feature, input_price, output_price, cost) values ($1, 'connect', 0, 0, 0)", [dev.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "delete from ai_usage")).rejects.toThrow(/permission denied/);
  });
});

describe("what people see", () => {
  it("shows developers their own budget and usage", async () => {
    const r = await reserve(dev, M, M);
    await settle(r.id, M, M / 2); // $2
    await reserve(dev2, 0, M);
    expect(await budget(dev)).toEqual({ enabled: true, spent: 2, quota: 5, cap_reached: false });
    expect(await budget(admin)).toMatchObject({ quota: null });
    expect(await budget(player)).toMatchObject({ quota: 0 });
    expect(await t.as(dev, "select user_id from ai_usage")).toEqual([{ user_id: dev.id }]);
    expect(await t.as(admin, "select count(*)::int as n from ai_usage")).toEqual([{ n: 2 }]);
  });

  it("tells developers when the monthly cap is used up", async () => {
    await reserve(admin, 0, 10 * M); // $20
    expect((await budget(dev)).cap_reached).toBe(true);
  });

  it("gives admins this month's overview", async () => {
    await reserve(dev, M, M);
    await reserve(dev, 0, M / 2);
    const [{ o }] = await t.as<{ o: { spent: number; calls: number; users: { user_id: string; spent: number; calls: number }[] } }>(admin, "select ai_month_overview() as o");
    expect(o.spent).toBe(4);
    expect(o.calls).toBe(2);
    expect(o.users).toMatchObject([{ user_id: dev.id, spent: 4, calls: 2 }]);
    await expect(t.as(dev, "select ai_month_overview()")).rejects.toThrow(/not_allowed/);
  });
});

describe("Toki Connect", () => {
  const job = (user: { id: string }, status = "working") =>
    t.service<{ id: string }>("insert into connect_jobs (user_id, installation_id, repo, features, status, state) values ($1, 7, 'me/game', '{saves}', $2, '{\"files\": {}}') returning id", [user.id, status]).then((r) => r[0].id);

  it("shows a run only to its developer and admins, without the AI's working memory", async () => {
    const id = await job(dev);
    expect(await t.as(dev, "select repo, status from connect_jobs where id = $1", [id])).toEqual([{ repo: "me/game", status: "working" }]);
    expect(await t.as(dev2, "select id from connect_jobs where id = $1", [id])).toEqual([]);
    expect(await t.as(admin, "select id from connect_jobs where id = $1", [id])).toHaveLength(1);
    await expect(t.as(dev, "select state from connect_jobs where id = $1", [id])).rejects.toThrow(/permission denied/);
  });

  it("shows the developer what went wrong, up to 500 characters", async () => {
    const id = await job(dev);
    await t.service("update connect_jobs set status = 'failed', error = 'ai_provider_error', error_detail = '504: gateway timeout' where id = $1", [id]);
    expect(await t.as(dev, "select error, error_detail from connect_jobs where id = $1", [id])).toEqual([{ error: "ai_provider_error", error_detail: "504: gateway timeout" }]);
    await expect(t.service("update connect_jobs set error_detail = $2 where id = $1", [id, "x".repeat(501)])).rejects.toThrow(/check/);
  });

  it("lets only the server start or change runs", async () => {
    await expect(t.as(dev, "insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'me/game', '{saves}')", [dev.id])).rejects.toThrow(/permission denied/);
    const id = await job(dev);
    await expect(t.as(dev, "update connect_jobs set status = 'done' where id = $1", [id])).rejects.toThrow(/permission denied/);
  });

  it("allows one run at a time per account", async () => {
    await job(dev);
    await expect(job(dev, "question")).rejects.toThrow(/duplicate key/);
    await job(dev2);
    await job(dev, "done");
  });

  it("checks what a run may do", async () => {
    await expect(t.service("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'me/game', '{xp}')", [dev.id])).rejects.toThrow(/check/);
    await expect(t.service("insert into connect_jobs (user_id, installation_id, repo, features) values ($1, 7, 'not a repo', '{saves}')", [dev.id])).rejects.toThrow(/check/);
    await expect(t.service("insert into connect_jobs (user_id, installation_id, repo, features, pr_url) values ($1, 7, 'me/game', '{saves}', 'https://evil.example')", [dev.id])).rejects.toThrow(/check/);
  });

  it("lets only the server connect GitHub installations; people see and remove their own", async () => {
    await expect(t.as(dev, "insert into github_installations (user_id, installation_id, account_login) values ($1, 1, 'me')", [dev.id])).rejects.toThrow(/permission denied/);
    await t.service("insert into github_installations (user_id, installation_id, account_login) values ($1, 1, 'me'), ($2, 2, 'other')", [dev.id, dev2.id]);
    expect(await t.as(dev, "select installation_id::text as id from github_installations")).toEqual([{ id: "1" }]);
    expect(await t.as(dev, "delete from github_installations where installation_id = 2 returning installation_id")).toEqual([]);
    expect(await t.as(dev, "delete from github_installations where installation_id = 1 returning installation_id")).toHaveLength(1);
  });
});

describe("server secrets", () => {
  it("can only be read and written by the server", async () => {
    await t.service("insert into server_secrets (name, value) values ('ai_api_key', 'v1:abc') on conflict (name) do update set value = excluded.value");
    expect(await t.service("select value from server_secrets where name = 'ai_api_key'")).toEqual([{ value: "v1:abc" }]);
    await expect(t.as(admin, "select value from server_secrets")).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "insert into server_secrets (name, value) values ('github_app', 'x')")).rejects.toThrow(/permission denied/);
    await expect(t.as(null, "select value from server_secrets")).rejects.toThrow(/permission denied/);
    await expect(t.service("insert into server_secrets (name, value) values ('other', 'x')")).rejects.toThrow(/check/);
  });
});

describe("Anthropic as provider", () => {
  it("keeps the Anthropic key apart from the other one", async () => {
    await t.service("insert into server_secrets (name, value) values ('anthropic_api_key', 'v1:x') on conflict (name) do update set value = excluded.value");
    expect(await t.service("select name from server_secrets where name = 'anthropic_api_key'")).toEqual([{ name: "anthropic_api_key" }]);
  });
});

describe("cleanup of old logs", () => {
  const job = (status: string, daysAgo: number) =>
    t.service<{ id: string }>(
      `insert into connect_jobs (user_id, installation_id, repo, features, status, created_at, updated_at)
       values ($1, 7, 'me/game', '{saves}', $2, now() - make_interval(days => $3), now() - make_interval(days => $3)) returning id`,
      [dev.id, status, daysAgo],
    ).then((r) => r[0].id);
  const usage = (status: string, daysAgo: number) =>
    t.service<{ id: number }>(
      `insert into ai_usage (user_id, feature, model, status, input_price, output_price, cost, created_at)
       values ($1, 'connect', 'm', $2, 1, 2, 0.01, now() - make_interval(days => $3)) returning id`,
      [dev.id, status, daysAgo],
    ).then((r) => r[0].id);

  it("deletes finished Connect runs after 90 days and AI cost rows after 400 days", async () => {
    const oldDone = await job("done", 120);
    const oldFailed = await job("failed", 95);
    const newDone = await job("done", 10);
    const oldOpen = await job("question", 120);
    const oldUsage = await usage("done", 500);
    const oldReserved = await usage("reserved", 500);
    const newUsage = await usage("done", 30);

    await t.service("select cleanup_old_logs()");

    const jobs = (await t.service<{ id: string }>("select id from connect_jobs")).map((r) => r.id);
    expect(jobs).not.toContain(oldDone);
    expect(jobs).not.toContain(oldFailed);
    expect(jobs).toEqual(expect.arrayContaining([newDone, oldOpen]));
    const rows = (await t.service<{ id: number }>("select id from ai_usage")).map((r) => Number(r.id));
    expect(rows).not.toContain(Number(oldUsage));
    expect(rows).toEqual(expect.arrayContaining([Number(oldReserved), Number(newUsage)]));
  });

  it("can't be run by players", async () => {
    await expect(t.as(player, "select cleanup_old_logs()")).rejects.toThrow(/permission denied/);
  });
});
