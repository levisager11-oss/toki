import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let a: { id: string };
let b: { id: string };

const rpc = <T = unknown>(who: Who, sql: string, params: unknown[] = []) => t.as<{ r: T }>(who, `select ${sql} as r`, params).then((r) => r[0].r);
const offer = (who: Who, to: string, gt: number, gi: string[], wt: number, wi: string[], replyTo: string | null = null) =>
  rpc<string>(who, "public.offer_trade($1, $2, $3::text[], $4, $5::text[], $6::uuid)", [to, gt, gi, wt, wi, replyTo]);
const tokens = async (u: { id: string }) => (await t.admin<{ tokens: number }>("select tokens from player_progress where user_id = $1", [u.id]))[0].tokens;
const status = async (id: string) => (await t.admin<{ status: string }>("select status from trades where id = $1", [id]))[0].status;
const setTokens = (u: { id: string }, n: number) => t.admin("update player_progress set tokens = $2 where user_id = $1", [u.id, n]);

beforeAll(async () => {
  t = await testDb();
  a = await t.user();
  b = await t.user();
  await t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [a.id, b.id]);
  for (const u of [a, b]) {
    await t.admin("insert into player_progress (user_id) values ($1) on conflict do nothing", [u.id]);
    await setTokens(u, 1000);
  }
  await t.admin("create or replace function public.trading_opens() returns timestamptz language sql stable as $$ select now() - interval '1 day' $$");
  await rpc(a, "public.buy_cosmetic('frame.mint')");
  await rpc(b, "public.buy_cosmetic('title.rookie')");
  await setTokens(a, 1000);
  await setTokens(b, 1000);
}, 60_000);

describe("gifts", () => {
  it("move items and tokens when the friend accepts, and ask for nothing back", async () => {
    const id = await offer(a, b.id, 30, ["frame.mint"], 0, []);
    const [note] = await t.admin<{ data: { event: string; gift?: boolean } }>(
      "select data from notifications where user_id = $1 and kind = 'trade' order by created_at desc, id desc limit 1", [b.id]);
    expect(note.data).toMatchObject({ event: "offer", gift: true });
    expect(await status(id)).toBe("open");
    expect(await tokens(a)).toBe(1000);
    expect(await rpc(b, "public.answer_trade($1, true)", [id])).toBe("done");
    expect(await tokens(a)).toBe(970);
    expect(await tokens(b)).toBe(1030);
    const owner = await t.admin<{ user_id: string }>("select user_id from player_cosmetics where cosmetic_id = 'frame.mint' and user_id = any($1)", [[a.id, b.id]]);
    expect(owner).toEqual([{ user_id: b.id }]);
    await setTokens(a, 1000);
    await setTokens(b, 1000);
  });

  it("can be declined, and a normal offer has no gift flag", async () => {
    const id = await offer(a, b.id, 10, [], 0, []);
    expect(await rpc(b, "public.answer_trade($1, false)", [id])).toBe("declined");
    expect(await tokens(b)).toBe(1000);
    const swap = await offer(a, b.id, 10, [], 5, []);
    const [note] = await t.admin<{ data: { gift?: boolean } }>(
      "select data from notifications where user_id = $1 and kind = 'trade' and data->>'trade' = $2", [b.id, swap]);
    expect(note.data.gift).toBeUndefined();
    await rpc(a, "public.cancel_trade($1)", [swap]);
  });

  it("must still give something", async () => {
    await expect(offer(a, b.id, 0, [], 0, [])).rejects.toThrow();
    await expect(offer(a, b.id, 0, [], 5, [])).rejects.toThrow();
  });

  it("still need a friend, and can't be pushed on anyone", async () => {
    const stranger = await t.user();
    await expect(offer(a, stranger.id, 10, [], 0, [])).rejects.toThrow(/not_friends/);
    const id = await offer(a, b.id, 10, [], 0, []);
    await expect(rpc(a, "public.answer_trade($1, true)", [id])).rejects.toThrow(/not_found/);
    await rpc(a, "public.cancel_trade($1)", [id]);
  });
});

describe("counter-offers", () => {
  it("decline the original when sent", async () => {
    const original = await offer(a, b.id, 20, [], 0, ["title.rookie"]);
    const counter = await offer(b, a.id, 0, ["title.rookie"], 20, [], original);
    expect(await status(original)).toBe("declined");
    expect(await status(counter)).toBe("open");
    const [note] = await t.admin<{ data: { counter?: boolean } }>(
      "select data from notifications where user_id = $1 and kind = 'trade' and data->>'trade' = $2", [a.id, counter]);
    expect(note.data.counter).toBe(true);
    await rpc(b, "public.cancel_trade($1)", [counter]);
  });

  it("only answer an open offer one received from that friend", async () => {
    const mine = await offer(a, b.id, 5, [], 0, []);
    await expect(offer(a, b.id, 5, [], 1, [], mine)).rejects.toThrow(/not_found/); // own offer
    await rpc(b, "public.answer_trade($1, false)", [mine]);
    await expect(offer(b, a.id, 5, [], 1, [], mine)).rejects.toThrow(/not_found/); // already answered
    const stranger = await t.user();
    await t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [stranger.id, b.id]);
    const other = await offer(a, b.id, 5, [], 0, []);
    await expect(offer(b, stranger.id, 5, [], 1, [], other)).rejects.toThrow(/not_found/); // from someone else
    await rpc(a, "public.cancel_trade($1)", [other]);
  });

  it("leave the original open when the counter is refused", async () => {
    const original = await offer(a, b.id, 20, [], 0, []);
    await expect(offer(b, a.id, 0, [], 20, [], original)).rejects.toThrow(); // gives nothing
    expect(await status(original)).toBe("open");
    await rpc(a, "public.cancel_trade($1)", [original]);
  });
});

describe("tokens received a day", () => {
  it("are capped for the receiver, counting what they got before", async () => {
    const sender = await t.user();
    const getter = await t.user();
    await t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [sender.id, getter.id]);
    for (const u of [sender, getter]) {
      await t.admin("insert into player_progress (user_id) values ($1) on conflict do nothing", [u.id]);
      await setTokens(u, 1000);
    }
    const one = await offer(sender, getter.id, 150, [], 0, []);
    expect(await rpc(getter, "public.answer_trade($1, true)", [one])).toBe("done");
    const two = await offer(sender, getter.id, 51, [], 0, []);
    await expect(rpc(getter, "public.answer_trade($1, true)", [two])).rejects.toThrow(/rate_limited:trade_tokens_day/);
    expect(await status(two)).toBe("open");
    expect(await tokens(getter)).toBe(1150);
    const three = await offer(sender, getter.id, 50, [], 0, []);
    expect(await rpc(getter, "public.answer_trade($1, true)", [three])).toBe("done");
  });

  it("follow the limit an admin sets, and don't count what a player gives away", async () => {
    const sender = await t.user();
    const getter = await t.user();
    await t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [sender.id, getter.id]);
    for (const u of [sender, getter]) {
      await t.admin("insert into player_progress (user_id) values ($1) on conflict do nothing", [u.id]);
      await setTokens(u, 1000);
    }
    await t.admin("update limits set player = 10, creator = 10 where key = 'trade_tokens_day'");
    const over = await offer(sender, getter.id, 11, [], 0, []);
    await expect(rpc(getter, "public.answer_trade($1, true)", [over])).rejects.toThrow(/trade_tokens_day/);
    const ok = await offer(sender, getter.id, 10, [], 0, []);
    expect(await rpc(getter, "public.answer_trade($1, true)", [ok])).toBe("done");
    // Receiving from a swap counts only what is left over after paying.
    const swap = await offer(sender, getter.id, 5, [], 5, []);
    expect(await rpc(getter, "public.answer_trade($1, true)", [swap])).toBe("done");
    // The giver may give again: only receiving is capped.
    const back = await offer(getter, sender.id, 10, [], 0, []);
    expect(await rpc(sender, "public.answer_trade($1, true)", [back])).toBe("done");
    await t.admin("update limits set player = 200, creator = 200 where key = 'trade_tokens_day'");
  });
});
