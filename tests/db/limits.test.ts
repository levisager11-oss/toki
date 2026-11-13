import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
}, 60_000);

type Mine = { limits: Record<string, number | null>; keep: Record<string, number> };
const mine = async (who: Who) => (await t.as<{ my_limits: Mine }>(who, "select my_limits()"))[0].my_limits;
const setLimit = (who: Who, key: string, player: number, creator: number) =>
  t.as(who, "select admin_set_limit($1, $2, $3)", [key, player, creator]);
const override = (who: Who, user: string, key: string, value: number | null) =>
  t.as(who, "select admin_set_limit_override($1, $2, $3)", [user, key, value]);
const propose = (who: Who) => t.as(who, "insert into game_ideas (title, body) values ('An idea', 'With a body.')");

describe("reading", () => {
  it("gives visitors and players the players' values, developers theirs, and admins none", async () => {
    const player = await t.user();
    const dev = await t.user("creator");
    expect((await mine(null)).limits.ideas_day).toBe(3);
    expect((await mine(player)).limits).toMatchObject({ ideas_day: 3, messages_hour: 200, group_size: 20 });
    expect((await mine(dev)).limits.storage_mb).toBe(1024);
    const a = await mine(admin);
    expect(a.limits.ideas_day).toBeNull();
    // Sizes are the same for everyone, admins too.
    expect(a.limits).toMatchObject({ group_size: 20, party_size: 8 });
    expect(a.keep).toMatchObject({ chat_public: 7, chat_private: 30, notifications: 30, notifications_count: 100 });
  });

  it("keeps the tables to admins and the functions", async () => {
    const player = await t.user();
    await expect(t.as(player, "select * from limits")).rejects.toThrow();
    await expect(t.as(player, "select * from limit_overrides")).rejects.toThrow();
    await expect(t.as(player, "select * from keep_times")).rejects.toThrow();
    await expect(t.as(player, "select limit_of($1, 'ideas_day')", [player.id])).rejects.toThrow();
    await expect(t.as(player, "select admin_limits()")).rejects.toThrow("not_allowed");
    const all = (await t.as<{ admin_limits: { limits: { key: string }[]; keep: unknown[] } }>(admin, "select admin_limits()"))[0].admin_limits;
    expect(all.limits.map((l) => l.key)).toContain("ideas_day");
    expect(all.keep.length).toBeGreaterThan(5);
  });
});

describe("changing", () => {
  it("only admins change limits, within their range", async () => {
    const dev = await t.user("creator");
    await expect(setLimit(dev, "groups_day", 5, 5)).rejects.toThrow("not_allowed");
    await expect(setLimit(admin, "groups_day", -1, 5)).rejects.toThrow("out_of_range");
    await expect(setLimit(admin, "group_size", 2, 2)).rejects.toThrow("out_of_range");
    await expect(setLimit(admin, "nope", 1, 1)).rejects.toThrow("unknown_limit");
    await expect(t.as(admin, "select admin_set_keep_time('chat_public', 91)")).rejects.toThrow("out_of_range");
    await t.as(admin, "select admin_set_keep_time('chat_public', 14)");
    expect((await mine(null)).keep.chat_public).toBe(14);
    await t.as(admin, "select admin_set_keep_time('chat_public', 7)");
  });

  it("applies the players' and the developers' value to new ideas", async () => {
    await setLimit(admin, "ideas_day", 1, 2);
    const player = await t.user();
    const dev = await t.user("creator");
    await propose(player);
    await expect(propose(player)).rejects.toThrow("rate_limited:ideas_day");
    await propose(dev);
    await propose(dev);
    await expect(propose(dev)).rejects.toThrow("rate_limited:ideas_day");
    // Admins have no limit.
    for (let i = 0; i < 4; i++) await propose(admin);
    await setLimit(admin, "ideas_day", 3, 3);
  });

  it("lets an account have its own value, until it is removed", async () => {
    const player = await t.user();
    await override(admin, player.id, "ideas_day", 0);
    expect((await mine(player)).limits.ideas_day).toBe(0);
    await expect(propose(player)).rejects.toThrow("rate_limited:ideas_day");
    await override(admin, player.id, "ideas_day", 5);
    for (let i = 0; i < 5; i++) await propose(player);
    await expect(propose(player)).rejects.toThrow("rate_limited:ideas_day");
    await override(admin, player.id, "ideas_day", null);
    expect((await mine(player)).limits.ideas_day).toBe(3);
    // Sizes can't be overridden.
    await expect(override(admin, player.id, "group_size", 50)).rejects.toThrow("unknown_limit");
    await expect(override(player, player.id, "ideas_day", 50)).rejects.toThrow("not_allowed");
  });

  it("keeps single-value limits the same in both columns", async () => {
    await setLimit(admin, "party_size", 4, 60);
    const rows = await t.admin<{ player: number; creator: number }>("select player, creator from limits where key = 'party_size'");
    expect(rows[0]).toEqual({ player: 4, creator: 4 });
    await setLimit(admin, "party_size", 8, 8);
  });

  it("uses the AI calls per hour that the admin set", async () => {
    await t.admin("update ai_settings set enabled = true, monthly_cap = 100");
    const player = await t.user();
    await override(admin, player.id, "ai_suggest", 1);
    const take = () => t.service("select ai_reserve($1, 'suggest', null, 10, 10)", [player.id]);
    await take();
    await expect(take()).rejects.toThrow("rate_limited");
  });
});

describe("every limit in the table is used", () => {
  it("has a value for each key the database checks", async () => {
    const keys = (await t.admin<{ key: string }>("select key from limits")).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([
      "ideas_day", "ideas_month", "idea_replies_hour", "feedback_posts_hour", "feedback_posts_day", "feedback_replies_hour",
      "messages_20s", "messages_hour", "groups_day", "group_size", "reports_day", "friend_requests_day",
      "game_invites_10min", "party_size", "applications_month", "uploads_hour", "storage_mb",
    ]));
    // A misspelt key raises instead of quietly meaning no limit.
    await expect(t.admin("select limit_of($1, 'idea_day')", [admin.id])).rejects.toThrow("unknown_limit");
  });
});
