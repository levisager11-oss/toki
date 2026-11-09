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
  await t.admin(`update ai_settings set enabled = true, base_url = 'https://ai.example/v1', model = 'test-model',
    input_price = 1, output_price = 2, monthly_cap = 20, default_quota = 5`);
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
    expect(await t.as(admin, "select model from ai_settings")).toEqual([{ model: "test-model" }]);
    expect(await t.as(dev, "select model from ai_settings")).toEqual([]);
    expect(await t.as(player, "select model from ai_settings")).toEqual([]);
    await expect(t.as(null, "select model from ai_settings")).rejects.toThrow(/permission denied/);
    expect(await t.as(dev, "update ai_settings set monthly_cap = 999 returning id")).toEqual([]);
    const [s] = await t.as<{ monthly_cap: string; updated_by: string }>(admin, "update ai_settings set monthly_cap = 15 returning monthly_cap, updated_by");
    expect(s).toEqual({ monthly_cap: "15.00", updated_by: admin.id });
  });

  it("can't be turned on without an endpoint, a model and prices", async () => {
    await expect(t.as(admin, "update ai_settings set input_price = 0")).rejects.toThrow(/check/);
    await expect(t.as(admin, "update ai_settings set model = ''")).rejects.toThrow(/check/);
    await expect(t.as(admin, "update ai_settings set base_url = 'http://insecure.example'")).rejects.toThrow(/check/);
    await t.as(admin, "update ai_settings set enabled = false, input_price = 0");
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
    expect(r).toMatchObject({ provider: "openai_compatible", base_url: "https://ai.example/v1", model: "test-model" });
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

  it("refuses when the AI is off, and for players", async () => {
    await expect(reserve(player, 1, 1)).rejects.toThrow(/not_allowed/);
    await expect(reserve(dev, 1, 1, "test")).rejects.toThrow(/not_allowed/);
    await reserve(admin, 1, 1, "test");
    await t.admin("update ai_settings set enabled = false");
    await expect(reserve(dev, 1, 1)).rejects.toThrow(/ai_disabled/);
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
