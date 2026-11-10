import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let dev: { id: string };
let multi: { id: string; slug: string };
let other: { id: string; slug: string };
let single: { id: string };
let a: { id: string; username: string };
let b: { id: string; username: string };
let c: { id: string; username: string };

interface Party {
  id: string; leader: string; game: string | null; code: string | null; seq: number; chat: string;
  members: { id: string; username: string; playing: string | null }[];
}

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
  multi = await t.game(dev);
  other = await t.game(dev);
  single = await t.game(dev);
  await t.as(dev, "update games set multiplayer = true where id = any($1::uuid[])", [[multi.id, other.id]]);
}, 60_000);

beforeEach(async () => {
  await t.admin("delete from parties");
  a = await t.user();
  b = await t.user();
  c = await t.user();
});

const rpc = async <T = unknown>(who: Who, fn: string, args: unknown[] = [], types: string[] = []) => {
  const params = args.map((_, i) => `$${i + 1}${types[i] ? `::${types[i]}` : ""}`).join(", ");
  const rows = await t.as<Record<string, T>>(who, `select ${fn}(${params}) as r`, args);
  return rows[0]?.r as T;
};
const befriend = async (x: { id: string }, y: { id: string }) => {
  await rpc(x, "send_friend_request", [y.id], ["uuid"]);
  await rpc(y, "answer_friend_request", [x.id, true], ["uuid", "boolean"]);
};
const invite = (from: Who, to: { id: string }, g = multi, code = "ABCD") => rpc(from, "invite_to_game", [to.id, g.id, code], ["uuid", "uuid", "text"]);
const ping = (who: Who, here = true) => rpc<{ chats: number; party: Party | null; invite: { party: string } | null }>(who, "ping", [null, here], ["uuid", "boolean"]);
const join = (who: Who, party: string, code: string | null = null) => rpc<Party>(who, "join_party", [party, code], ["uuid", "text"]);
const room = (who: Who, code: string | null, g = multi) => rpc<Party | null>(who, "party_room", [g.id, code], ["uuid", "text"]);
const names = (p: Party | null) => p?.members.map((m) => m.username);
/** An invite from x that y accepted: the two are a party. */
const together = async (x: { id: string }, y: { id: string }) => {
  await befriend(x, y);
  await invite(x, y);
  return join(y, (await ping(y)).invite!.party);
};

describe("a party", () => {
  it("comes together when a friend accepts an invite", async () => {
    await befriend(a, b);
    expect((await ping(a)).party).toBeNull();
    await invite(a, b);
    // Whoever invites leads a party, in the room they invited to.
    const mine = (await ping(a)).party!;
    expect(mine).toMatchObject({ leader: a.id, game: multi.id, code: "ABCD", seq: 1 });
    expect(names(mine)).toEqual([a.username]);
    // The invite says which party.
    const got = await ping(b);
    expect(got.invite).toMatchObject({ party: mine.id });
    expect(got.party).toBeNull();
    const joined = await join(b, mine.id);
    expect(names(joined)).toEqual([a.username, b.username]);
    expect((await ping(b)).party).toMatchObject({ id: mine.id, leader: a.id, code: "ABCD" });
    // Joining again changes nothing.
    expect(names(await join(b, mine.id))).toEqual([a.username, b.username]);
  });

  it("needs an invite from a member, or the room's code as a member's friend", async () => {
    const party = await together(a, b);
    await expect(join(c, party.id)).rejects.toThrow(/not_invited/);
    await expect(join(c, party.id, "ABCD")).rejects.toThrow(/not_invited/); // knows the code, but nobody's friend
    await expect(join(null, party.id)).rejects.toThrow(/permission denied/);
    await expect(join(c, crypto.randomUUID())).rejects.toThrow(/not_found/);
    // A member's friend with the code of the room the party is in (a shared link).
    await befriend(b, c);
    await expect(join(c, party.id, "WRONG")).rejects.toThrow(/not_invited/);
    expect(names(await join(c, party.id, "ABCD"))).toEqual([a.username, b.username, c.username]);
  });

  it("takes invites from members who don't lead it", async () => {
    const party = await together(a, b);
    await befriend(b, c);
    await invite(b, c);
    expect((await ping(c)).invite).toMatchObject({ party: party.id });
    expect(names(await join(c, party.id))).toHaveLength(3);
    // b's invite didn't move the party.
    expect((await ping(a)).party).toMatchObject({ leader: a.id, seq: 1 });
  });

  it("doesn't take an old invite, a blocked player, or a ninth player", async () => {
    await befriend(a, b);
    await invite(a, b);
    const id = (await ping(a)).party!.id;
    await t.admin("update notifications set created_at = now() - interval '31 minutes' where user_id = $1", [b.id]);
    await expect(join(b, id)).rejects.toThrow(/not_invited/);

    await befriend(a, c);
    await invite(a, c);
    await t.admin("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [a.id, c.id]);
    await expect(join(c, id)).rejects.toThrow(/blocked/);
    await t.admin("delete from blocks");

    for (let i = 0; i < 7; i++) {
      const u = await t.user();
      await t.admin("insert into party_members (user_id, party_id) values ($1, $2)", [u.id, id]);
    }
    await expect(join(c, id)).rejects.toThrow(/party_full/);
  });

  it("follows its leader's room, and only the leader's", async () => {
    await together(a, b);
    // Another room in the same game, then another game: each one counts up.
    expect(await room(a, "EFGH")).toMatchObject({ code: "EFGH", seq: 2 });
    expect(await room(a, "IJKL", other)).toMatchObject({ game: other.id, code: "IJKL", seq: 3 });
    expect((await ping(b)).party).toMatchObject({ game: other.id, code: "IJKL", seq: 3 });
    // The leader leaves the room: nowhere to follow to. Back in the same room: nobody moves again.
    expect(await room(a, null, other)).toMatchObject({ code: null, seq: 3 });
    expect(await room(a, "IJKL", other)).toMatchObject({ code: "IJKL", seq: 3 });
    // Leaving a game the party isn't in closes nothing.
    expect(await room(a, null, multi)).toMatchObject({ code: "IJKL", seq: 3 });
    // A member's room changes nothing.
    expect(await room(b, "ZZZZ")).toMatchObject({ game: other.id, code: "IJKL", seq: 3 });
    // Nobody's party.
    expect(await room(c, "ZZZZ")).toBeNull();
    await expect(room(a, "not a code")).rejects.toThrow(/bad_code/);
    await expect(rpc(a, "party_room", [single.id, "ABCD"], ["uuid", "text"])).rejects.toThrow(/not_found/);
  });

  it("goes on without a member who leaves, and ends when everyone left", async () => {
    const party = await together(a, b);
    await befriend(a, c);
    await t.admin("update notifications set created_at = now() - interval '1 minute'");
    await invite(a, c);
    await join(c, party.id);
    // The leader leaves: the longest member leads, and their room isn't known yet.
    await rpc(a, "leave_party");
    expect((await ping(a)).party).toBeNull();
    const now = (await ping(b)).party!;
    expect(now).toMatchObject({ leader: b.id, code: null });
    expect(names(now)).toEqual([b.username, c.username]);
    expect(await room(b, "NEXT")).toMatchObject({ code: "NEXT", seq: 2 });
    await rpc(b, "leave_party");
    await rpc(c, "leave_party");
    expect(await t.admin("select 1 from parties")).toHaveLength(0);
    expect(await t.admin("select 1 from chats where kind = 'party'")).toHaveLength(0);
  });

  it("is left for the party of a newer invite", async () => {
    const first = await together(a, b);
    await befriend(c, b);
    await invite(c, b, other, "WXYZ");
    const second = await join(b, (await ping(b)).invite!.party);
    expect(second.id).not.toBe(first.id);
    expect(names(second)).toEqual([c.username, b.username]);
    expect(names((await ping(a)).party)).toEqual([a.username]);
  });

  it("drops members who left Toki, and ends after a while alone", async () => {
    const party = await together(a, b);
    await ping(a);
    await ping(b);
    // b's Toki has been closed for a while; a still asks for news.
    await t.admin("update presence set last_seen = now() - interval '16 minutes' where user_id = $1", [b.id]);
    await t.admin("update party_members set joined_at = now() - interval '20 minutes' where user_id = $1", [b.id]);
    expect(names((await ping(a)).party)).toEqual([a.username]);
    // Alone, the party waits for invited friends for half an hour.
    expect((await ping(a)).party).toMatchObject({ id: party.id });
    await t.admin("update parties set updated_at = now() - interval '31 minutes'");
    expect((await ping(a)).party).toBeNull();
    expect(await t.admin("select 1 from parties")).toHaveLength(0);
  });

  it("can be made for a link to share", async () => {
    const mine = await rpc<Party>(a, "open_party", [multi.id, "ABCD"], ["uuid", "text"]);
    expect(mine).toMatchObject({ leader: a.id, code: "ABCD" });
    expect((await rpc<Party>(a, "open_party", [multi.id, "ABCD"], ["uuid", "text"])).id).toBe(mine.id);
    await expect(rpc(a, "open_party", [multi.id, null], ["uuid", "text"])).rejects.toThrow(/bad_code/);
    await expect(rpc(null, "open_party", [multi.id, "ABCD"], ["uuid", "text"])).rejects.toThrow(/permission denied/);
    await befriend(a, b);
    expect(names(await join(b, mine.id, "ABCD"))).toEqual([a.username, b.username]);
  });
});

describe("a party's chat", () => {
  const say = (who: Who, chat: string, body = "hi") => t.as(who, "insert into messages (chat_id, body) values ($1, $2)", [chat, body]);

  it("is for its members only, and stays out of the list of chats", async () => {
    const party = await together(a, b);
    await say(a, party.chat, "ready?");
    expect(await t.as<{ body: string }>(b, "select body from messages where chat_id = $1", [party.chat])).toEqual([{ body: "ready?" }]);
    expect(await t.as(c, "select body from messages where chat_id = $1", [party.chat])).toHaveLength(0);
    await expect(say(c, party.chat)).rejects.toThrow(/not_member/);
    expect(await t.as(b, "select * from my_chats()")).toHaveLength(0);
    expect((await ping(b)).chats).toBe(0);
    // No "you were added to a group" for it.
    expect(await t.as(b, "select 1 from notifications where kind = 'group_add'")).toHaveLength(0);
  });

  it("is closed to a member who left, and deleted with the party", async () => {
    const party = await together(a, b);
    await say(b, party.chat);
    await rpc(b, "leave_party");
    await expect(say(b, party.chat)).rejects.toThrow(/not_member/);
    expect(await t.as(b, "select 1 from messages where chat_id = $1", [party.chat])).toHaveLength(0);
    await rpc(a, "leave_party");
    expect(await t.admin("select 1 from messages where chat_id = $1", [party.chat])).toHaveLength(0);
  });

  it("can't be read or changed around the functions", async () => {
    await together(a, b);
    await expect(t.as(a, "select * from parties")).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "select * from party_members")).rejects.toThrow(/permission denied/);
    await expect(t.as(c, "select party_state(id) from parties")).rejects.toThrow(/permission denied/);
    await expect(rpc(c, "party_drop", [a.id], ["uuid"])).rejects.toThrow(/permission denied/);
  });
});

describe("push for invites", () => {
  const device = (who: Who, endpoint: string, lang = "en") =>
    rpc(who, "save_push_subscription", [endpoint, "B".repeat(87), "a".repeat(22), lang], ["text", "text", "text", "text"]);
  const take = (from: { id: string }, to: { id: string }) =>
    t.service<{ r: { from: string; slug: string; code: string; party: string; devices: { endpoint: string; lang: string }[] } | null }>(
      "select take_invite_push($1::uuid, $2::uuid) as r", [from.id, to.id]).then((r) => r[0].r);

  it("goes to the friend's devices, once per invite", async () => {
    await befriend(a, b);
    await device(b, "https://push.example/b1", "de");
    await invite(a, b);
    const push = await take(a, b);
    expect(push).toMatchObject({ from: a.username, slug: multi.slug, code: "ABCD", devices: [{ endpoint: "https://push.example/b1", lang: "de" }] });
    expect(push!.party).toBe((await ping(a)).party!.id);
    expect(await take(a, b)).toBeNull(); // already sent
    expect(await take(b, a)).toBeNull(); // no invite that way
    // The pop-up still gets the invite.
    expect((await ping(b, false)).invite).not.toBeNull();
  });

  it("is not sent while the friend is on Toki, or has no device", async () => {
    await befriend(a, b);
    await invite(a, b);
    expect(await take(a, b)).toBeNull(); // no device
    await device(b, "https://push.example/b1");
    await ping(b); // on Toki right now
    await t.admin("update notifications set created_at = now() - interval '1 minute' where user_id = $1", [b.id]);
    await invite(a, b);
    expect(await take(a, b)).toBeNull();
  });

  it("keeps a player's 5 newest devices, each with one owner", async () => {
    for (let i = 0; i < 7; i++) {
      await device(a, `https://push.example/a${i}`);
      await t.admin("update push_subscriptions set seen_at = now() - make_interval(mins => $1) where endpoint = $2", [10 - i, `https://push.example/a${i}`]);
    }
    const mine = await t.admin<{ endpoint: string }>("select endpoint from push_subscriptions where user_id = $1 order by endpoint", [a.id]);
    expect(mine.map((r) => r.endpoint)).toEqual([2, 3, 4, 5, 6].map((i) => `https://push.example/a${i}`));
    // Someone else logs in on that device: it is theirs now.
    await device(b, "https://push.example/a6");
    expect(await t.admin("select 1 from push_subscriptions where user_id = $1", [a.id])).toHaveLength(4);
    // Turning it off only works for one's own device.
    await rpc(a, "remove_push_subscription", ["https://push.example/a6"], ["text"]);
    expect(await t.admin("select 1 from push_subscriptions where endpoint = 'https://push.example/a6'")).toHaveLength(1);
    await rpc(b, "remove_push_subscription", ["https://push.example/a6"], ["text"]);
    expect(await t.admin("select 1 from push_subscriptions where endpoint = 'https://push.example/a6'")).toHaveLength(0);
  });

  it("is closed to players", async () => {
    await expect(t.as(a, "select * from push_subscriptions")).rejects.toThrow(/permission denied/);
    await expect(rpc(a, "take_invite_push", [a.id, b.id], ["uuid", "uuid"])).rejects.toThrow(/permission denied/);
    await expect(device(null, "https://push.example/x")).rejects.toThrow(/permission denied/);
    await expect(device(a, "http://push.example/x")).rejects.toThrow(/endpoint/);
  });
});
