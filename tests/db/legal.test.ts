import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
}, 60_000);

const rpc = async <T = unknown>(who: Who, fn: string, args: unknown[] = [], types: string[] = []) => {
  const params = args.map((_, i) => `$${i + 1}${types[i] ? `::${types[i]}` : ""}`).join(", ");
  const rows = await t.as<Record<string, T>>(who, `select ${fn}(${params}) as r`, args);
  return rows[0]?.r as T;
};

/** "YYYY-MM" of someone who turned `years` this many months ago. */
const born = (years: number, monthsAgo = 2) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 7);
};
let n = 0;
const signUp = async (meta: Record<string, unknown>) => {
  const id = crypto.randomUUID();
  await t.admin("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${id}@example.com`, { username: `legal_${++n}`, ...meta }]);
  return { id };
};
const exists = async (id: string) => (await t.admin("select 1 from auth.users where id = $1", [id])).length === 1;

describe("age at sign-up", () => {
  it("gives no account to players under 13", async () => {
    await expect(signUp({ born: born(12) })).rejects.toThrow(/too_young/);
    // 13 this month: counted as 12 until the month is over
    await expect(signUp({ born: born(13, 0) })).rejects.toThrow(/too_young/);
  });

  it("needs a parent's OK from 13 to 15", async () => {
    await expect(signUp({ born: born(14) })).rejects.toThrow(/parent_required/);
    const kid = await signUp({ born: born(14), parent_ok: true });
    const [p] = await t.admin<{ born: string; parent_ok_at: string | null }>("select born::text, parent_ok_at from profiles where id = $1", [kid.id]);
    expect(p.born).toBe(`${born(14)}-01`);
    expect(p.parent_ok_at).not.toBeNull();
    const adult = await signUp({ born: born(30) });
    expect(await t.admin("select 1 from profiles where id = $1 and parent_ok_at is null", [adult.id])).toHaveLength(1);
  });

  it("refuses months of birth that can't be", async () => {
    await expect(signUp({ born: "2010-13" })).rejects.toThrow(/bad_birth/);
    await expect(signUp({ born: "soon" })).rejects.toThrow(/bad_birth/);
    await expect(signUp({ born: "2999-01" })).rejects.toThrow(/bad_birth/);
  });

  it("keeps the month of birth private", async () => {
    const a = await signUp({ born: born(20) });
    const b = await t.user();
    await expect(t.as(b, "select born from profiles where id = $1", [a.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "update profiles set born = '1990-01-01' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
  });
});

describe("accounts from before the age question", () => {
  it("are asked once", async () => {
    const a = await t.user();
    expect(await rpc(a, "my_account")).toEqual({ age_needed: true });
    await expect(rpc(a, "set_birth", [born(15), false], ["text", "boolean"])).rejects.toThrow(/parent_required/);
    expect(await rpc(a, "set_birth", [born(15), true], ["text", "boolean"])).toBe("ok");
    expect(await rpc(a, "my_account")).toEqual({ age_needed: false });
    // a second answer changes nothing
    expect(await rpc(a, "set_birth", [born(40), false], ["text", "boolean"])).toBe("ok");
    expect(await t.admin("select 1 from profiles where id = $1 and born = $2::date", [a.id, `${born(15)}-01`])).toHaveLength(1);
  });

  it("are deleted when the player is under 13", async () => {
    const a = await t.user();
    expect(await rpc(a, "set_birth", [born(11), true], ["text", "boolean"])).toBe("too_young");
    expect(await exists(a.id)).toBe(false);
  });

  it("never delete an admin that way", async () => {
    await expect(rpc(admin, "set_birth", [born(11), true], ["text", "boolean"])).rejects.toThrow(/bad_birth/);
    expect(await exists(admin.id)).toBe(true);
  });
});

describe("deleting an account", () => {
  it("removes the account, its games and what it posted", async () => {
    const dev = await t.user("creator");
    const other = await t.user();
    const game = await t.game(dev);
    await t.as(dev, "insert into feedback_posts (kind, title) values ('idea', 'More levels')");
    await t.as(other, "insert into game_saves (game_id, user_id, data) values ($1, $2, '{}')", [game.id, other.id]).catch(() => {});
    await rpc(dev, "delete_account");
    expect(await exists(dev.id)).toBe(false);
    expect(await t.admin("select 1 from profiles where id = $1", [dev.id])).toHaveLength(0);
    expect(await t.admin("select 1 from games where id = $1", [game.id])).toHaveLength(0);
    expect(await t.admin("select 1 from feedback_posts where author_id = $1", [dev.id])).toHaveLength(0);
    expect(await exists(other.id)).toBe(true);
  });

  it("needs a login, and keeps the last admin", async () => {
    await expect(rpc(null, "delete_account")).rejects.toThrow(/permission denied/);
    await expect(rpc(admin, "delete_account")).rejects.toThrow(/last_admin/);
    const second = await t.user("admin");
    await rpc(second, "delete_account");
    expect(await exists(second.id)).toBe(false);
  });

  it("can't be used on someone else", async () => {
    const a = await t.user();
    await expect(rpc(a, "remove_account", [admin.id], ["uuid"])).rejects.toThrow(/permission denied/);
  });
});

describe("a copy of your data", () => {
  it("holds the account's own rows and nobody else's", async () => {
    const a = await signUp({ born: born(20) });
    const b = await t.user();
    await t.as(a, "insert into feedback_posts (kind, title) values ('idea', 'Mine')");
    await t.as(b, "insert into feedback_posts (kind, title) values ('idea', 'Not mine')");
    const data = await rpc<Record<string, unknown>>(a, "export_my_data");
    expect((data.account as { email: string; month_of_birth: string }).email).toBe(`${a.id}@example.com`);
    expect((data.account as { month_of_birth: string }).month_of_birth).toBe(born(20));
    expect((data.feedback_posts as { title: string }[]).map((p) => p.title)).toEqual(["Mine"]);
    expect(data.messages).toEqual([]);
    await expect(rpc(null, "export_my_data")).rejects.toThrow(/permission denied/);
  });

  it("leaves out keys only a device or the server should know", async () => {
    const cols = await t.admin<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'
         and table_name in ('push_subscriptions', 'github_installations', 'connect_jobs', 'developer_applications', 'presence', 'party_members')
         and (column_name ~ '(secret|token|hash|password|p256dh)' or column_name = 'auth')`);
    const kept = cols.filter((c) => !["p256dh", "auth", "token", "key_hash"].includes(c.column_name));
    expect(kept).toEqual([]);
  });
});

describe("reports", () => {
  it("reach only the admins, once per player and thing", async () => {
    const dev = await t.user("creator");
    const a = await t.user();
    const game = await t.game(dev);
    await rpc(a, "report_content", ["game", game.id, "copyright", "  Copied from my game  "], ["text", "uuid", "text", "text"]);
    await rpc(a, "report_content", ["game", game.id, "spam", "again"], ["text", "uuid", "text", "text"]);
    expect(await t.as(a, "select * from content_reports")).toHaveLength(0);
    expect(await t.as(dev, "select * from content_reports")).toHaveLength(0);
    const rows = await t.as<{ category: string; reason: string; owner_id: string }>(admin, "select * from content_reports where target = $1", [game.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "copyright", reason: "Copied from my game", owner_id: dev.id });
  });

  it("refuse visitors, your own things, and things that don't exist", async () => {
    const dev = await t.user("creator");
    const game = await t.game(dev);
    const args = ["text", "uuid", "text", "text"];
    await expect(rpc(null, "report_content", ["game", game.id, "spam", ""], args)).rejects.toThrow(/permission denied/);
    await expect(rpc(dev, "report_content", ["game", game.id, "spam", ""], args)).rejects.toThrow(/not_found/);
    await expect(rpc(dev, "report_content", ["game", crypto.randomUUID(), "spam", ""], args)).rejects.toThrow(/not_found/);
    await expect(rpc(dev, "report_content", ["chat", admin.id, "spam", ""], args)).rejects.toThrow(/not_found/);
  });

  it("removing tells the owner why and the reporter what happened", async () => {
    const dev = await t.user("creator");
    const a = await t.user();
    const b = await t.user();
    const game = await t.game(dev);
    const args = ["text", "uuid", "text", "text"];
    await rpc(a, "report_content", ["game", game.id, "illegal", ""], args);
    await rpc(b, "report_content", ["game", game.id, "illegal", ""], args);
    const [r] = await t.as<{ id: number }>(admin, "select id from content_reports where target = $1 order by id", [game.id]);
    const handle = ["bigint", "text", "text", "integer"];
    await expect(rpc(a, "handle_content_report", [r.id, "removed", "x", 0], handle)).rejects.toThrow(/not_allowed/);
    await rpc(admin, "handle_content_report", [r.id, "removed", "Uses music without permission", 0], handle);
    expect(await t.admin("select 1 from games where id = $1", [game.id])).toHaveLength(0);
    expect(await t.admin("select 1 from content_reports where target = $1 and outcome = 'removed'", [game.id])).toHaveLength(2);
    const [toOwner] = await t.as<{ kind: string; data: Record<string, unknown> }>(dev, "select kind, data from notifications where kind = 'moderation'");
    expect(toOwner.data).toMatchObject({ what: "game", note: "Uses music without permission" });
    for (const who of [a, b]) {
      const [toReporter] = await t.as<{ data: Record<string, unknown> }>(who, "select data from notifications where kind = 'report_done'");
      expect(toReporter.data).toMatchObject({ what: "game", outcome: "removed" });
    }
    // handled once
    await expect(rpc(admin, "handle_content_report", [r.id, "dismissed", "", 0], handle)).rejects.toThrow(/not_found/);
  });

  it("hide feedback posts, empty profiles, and ban", async () => {
    const a = await t.user();
    const b = await t.user();
    const args = ["text", "uuid", "text", "text"];
    const handle = ["bigint", "text", "text", "integer"];
    const [post] = await t.as<{ id: string }>(a, "insert into feedback_posts (kind, title) values ('idea', 'Rude words') returning id");
    await t.as(a, "update profiles set bio = 'rude' where id = $1", [a.id]);
    await rpc(b, "report_content", ["feedback", post.id, "harassment", ""], args);
    await rpc(b, "report_content", ["profile", a.id, "harassment", ""], args);
    const reports = await t.as<{ id: number; kind: string }>(admin, "select id, kind from content_reports where owner_id = $1", [a.id]);
    await rpc(admin, "handle_content_report", [reports.find((r) => r.kind === "feedback")!.id, "removed", "", 0], handle);
    await rpc(admin, "handle_content_report", [reports.find((r) => r.kind === "profile")!.id, "banned", "", 7], handle);
    expect(await t.admin("select 1 from feedback_posts where id = $1 and hidden", [post.id])).toHaveLength(1);
    expect(await t.admin("select 1 from profiles where id = $1 and bio = '' and banned_until > now()", [a.id])).toHaveLength(1);
  });

  it("of messages tell the sender and the reporter too", async () => {
    const a = await t.user();
    const b = await t.user();
    const room = await rpc<string>(a, "room", [null], ["uuid"]);
    const [m] = await t.as<{ id: number }>(a, "insert into messages (chat_id, body) values ($1, 'mean') returning id", [room]);
    await rpc(b, "report_message", [m.id, ""], ["bigint", "text"]);
    const [r] = await t.as<{ id: number }>(admin, "select id from message_reports where message_id = $1", [m.id]);
    await rpc(admin, "handle_report", [r.id, "deleted", 0], ["bigint", "text", "integer"]);
    expect(await t.as(a, "select 1 from notifications where kind = 'moderation' and data ->> 'what' = 'message'")).toHaveLength(1);
    expect(await t.as(b, "select 1 from notifications where kind = 'report_done' and data ->> 'outcome' = 'removed'")).toHaveLength(1);
  });
});

describe("what the privacy policy says about AI", () => {
  const facts = () => rpc<{ ai_hosts: string[]; games_hosted: boolean; changed_at: string | null }>(null, "policy_facts");
  const set = (sql: string) => t.admin(`update ai_settings set ${sql} where id = 1`);

  it("follows the AI settings, for everyone", async () => {
    expect((await facts()).ai_hosts).toEqual([]);
    // set up but still off: nothing is sent anywhere
    await set("provider = 'anthropic', base_url = '', model = 'm', input_price = 1, output_price = 1");
    expect((await facts()).ai_hosts).toEqual([]);
    await set("enabled = true");
    const on = await facts();
    expect(on.ai_hosts).toEqual(["api.anthropic.com"]);
    expect(on.changed_at).not.toBeNull();
    // a second service for the free AI; the same one twice is named once
    await set("free_enabled = true, free_base_url = 'https://API.Example.com:8443/v1', free_model = 'm'");
    expect((await facts()).ai_hosts).toEqual(["api.anthropic.com", "api.example.com"]);
    await set("free_base_url = 'https://api.anthropic.com/v1'");
    expect((await facts()).ai_hosts).toEqual(["api.anthropic.com"]);
    await set("enabled = false, free_enabled = false");
    expect((await facts()).ai_hosts).toEqual([]);
  });

  it("moves its date only when the service changes", async () => {
    await set("enabled = true");
    const before = (await facts()).changed_at;
    expect(before).not.toBeNull();
    // prices and models aren't in the policy
    await set("monthly_cap = 7, model = 'other'");
    expect((await facts()).changed_at).toBe(before);
    await new Promise((r) => setTimeout(r, 5));
    await set("provider = 'openai_compatible', base_url = 'https://api.example.com/v1'");
    expect((await facts()).changed_at).not.toBe(before);
    await set("enabled = false");
  });

  it("gives away nothing else", async () => {
    await expect(t.as(null, "select * from ai_settings")).rejects.toThrow(/permission denied/);
    expect(Object.keys(await facts()).sort()).toEqual(["ai_hosts", "changed_at", "games_hosted"]);
  });

  it("moves its date when a deletion time changes", async () => {
    const before = (await facts()).changed_at;
    await new Promise((r) => setTimeout(r, 5));
    await t.admin("update keep_times set value = value where key = 'chat_public'");
    expect((await facts()).changed_at).toBe(before);
    await t.admin("update keep_times set value = value + 1 where key = 'chat_public'");
    expect((await facts()).changed_at).not.toBe(before);
  });

  it("knows whether games are uploaded to Toki, and moves its date when that changes", async () => {
    const dev = await t.user("creator");
    await t.admin("update games set hosted_site = null");
    expect((await facts()).games_hosted).toBe(false);
    const game = await t.game(dev);
    const before = (await facts()).changed_at;
    await new Promise((r) => setTimeout(r, 5));
    await t.admin("update games set hosted_site = 'my-game' where id = $1", [game.id]);
    const hosted = await facts();
    expect(hosted.games_hosted).toBe(true);
    expect(hosted.changed_at).not.toBe(before);
    // a second uploaded game changes nothing the policy says
    const second = await t.game(dev);
    await new Promise((r) => setTimeout(r, 5));
    await t.admin("update games set hosted_site = 'other-game' where id = $1", [second.id]);
    expect((await facts()).changed_at).toBe(hosted.changed_at);
    await t.admin("delete from games where id in ($1, $2)", [game.id, second.id]);
    expect((await facts()).games_hosted).toBe(false);
  });
});
