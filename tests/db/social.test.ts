import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let game: { id: string };
let a: { id: string; username: string };
let b: { id: string; username: string };
let c: { id: string; username: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  game = await t.game(dev);
}, 60_000);

// Fresh players for each test, so friendships and limits don't carry over.
beforeEach(async () => {
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
  expect(await rpc(x, "send_friend_request", [y.id], ["uuid"])).toBe("sent");
  await rpc(y, "answer_friend_request", [x.id, true], ["uuid", "boolean"]);
};
const say = (who: Who, chat: string, body = "hi") =>
  t.as<{ id: number }>(who, "insert into messages (chat_id, body) values ($1, $2) returning id", [chat, body]).then((r) => r[0]);

describe("profiles", () => {
  it("let players change only their bio and avatar", async () => {
    await t.as(a, "update profiles set bio = '  Hello  ', avatar_seed = 'abc' where id = $1", [a.id]);
    expect((await t.admin("select bio, avatar_seed from profiles where id = $1", [a.id]))[0]).toEqual({ bio: "Hello", avatar_seed: "abc" });
    await expect(t.as(a, "update profiles set role = 'admin' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "update profiles set banned_until = null where id = $1", [a.id])).rejects.toThrow(/permission denied/);
    await t.as(a, "update profiles set bio = 'hacked' where id = $1", [b.id]);
    expect((await t.admin("select bio from profiles where id = $1", [b.id]))[0].bio).toBe("");
  });

  it("don't show bans to others", async () => {
    await expect(t.as(a, "select banned_until from profiles")).rejects.toThrow(/permission denied/);
    await expect(t.as(null, "select username, bio from profiles limit 1")).resolves.toBeDefined();
  });

  it("show online status and recently played only to friends", async () => {
    await rpc(b, "heartbeat", [game.id], ["uuid"]);
    await rpc(b, "record_play", [game.id, crypto.randomUUID()], ["uuid", "uuid"]);
    const stranger = await rpc<Record<string, unknown>>(a, "get_profile", [b.username]);
    expect(stranger).toMatchObject({ relation: "none" });
    expect(stranger).not.toHaveProperty("playing");
    expect(await t.as(a, "select * from presence where user_id = $1", [b.id])).toHaveLength(0);

    await befriend(a, b);
    const friend = await rpc<Record<string, unknown>>(a, "get_profile", [b.username]);
    expect(friend).toMatchObject({ relation: "friend", playing: game.id, recent: [game.id], friend_count: 1 });
    expect(await t.as(a, "select * from presence where user_id = $1", [b.id])).toHaveLength(1);
  });
});

describe("friends", () => {
  it("need the other player to accept", async () => {
    await rpc(a, "send_friend_request", [b.id], ["uuid"]);
    expect(await t.as(a, "select * from friends")).toHaveLength(0);
    expect((await rpc<Record<string, unknown>>(b, "get_profile", [a.username])).relation).toBe("received");
    await rpc(b, "answer_friend_request", [a.id, true], ["uuid", "boolean"]);
    expect(await t.as(a, "select friend_id from friends")).toEqual([{ friend_id: b.id }]);
    expect(await t.as(b, "select friend_id from friends")).toEqual([{ friend_id: a.id }]);
  });

  it("become friends at once when both sent a request", async () => {
    await rpc(a, "send_friend_request", [b.id], ["uuid"]);
    expect(await rpc(b, "send_friend_request", [a.id], ["uuid"])).toBe("friends");
  });

  it("can't be made by writing the tables directly", async () => {
    await expect(t.as(a, "insert into friends (user_id, friend_id) values ($1, $2)", [a.id, b.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "insert into friend_requests (from_id, to_id) values ($1, $2)", [b.id, a.id])).rejects.toThrow(/permission denied/);
  });

  it("end when one blocks the other, and blocked players can't send requests", async () => {
    await befriend(a, b);
    await rpc(a, "block_user", [b.id], ["uuid"]);
    expect(await t.as(b, "select * from friends")).toHaveLength(0);
    await expect(rpc(b, "send_friend_request", [a.id], ["uuid"])).rejects.toThrow(/blocked/);
    await rpc(a, "unblock_user", [b.id], ["uuid"]);
    expect(await rpc(b, "send_friend_request", [a.id], ["uuid"])).toBe("sent");
  });
});

describe("private messages", () => {
  it("only between friends, and only members read them", async () => {
    await expect(rpc(a, "open_dm", [b.id], ["uuid"])).rejects.toThrow(/not_friends/);
    await befriend(a, b);
    const chat = await rpc<string>(a, "open_dm", [b.id], ["uuid"]);
    expect(await rpc(b, "open_dm", [a.id], ["uuid"])).toBe(chat);
    await say(a, chat, "secret");
    expect(await t.as(b, "select body from messages where chat_id = $1", [chat])).toEqual([{ body: "secret" }]);
    expect(await t.as(c, "select body from messages where chat_id = $1", [chat])).toHaveLength(0);
    await expect(say(c, chat)).rejects.toThrow(/not_member/);
  });

  it("stop when the friendship ends", async () => {
    await befriend(a, b);
    const chat = await rpc<string>(a, "open_dm", [b.id], ["uuid"]);
    await rpc(b, "remove_friend", [a.id], ["uuid"]);
    await expect(say(a, chat)).rejects.toThrow(/not_friends/);
  });

  it("count as unread until the chat is opened", async () => {
    await befriend(a, b);
    const chat = await rpc<string>(a, "open_dm", [b.id], ["uuid"]);
    await say(a, chat, "one");
    await say(a, chat, "two");
    const [row] = await t.as<{ unread: number; last_body: string; other_username: string }>(b, "select * from my_chats() where id = $1", [chat]);
    expect(row).toMatchObject({ unread: 2, last_body: "two", other_username: a.username });
    await rpc(b, "mark_chat_read", [chat], ["uuid"]);
    expect((await t.as<{ unread: number }>(b, "select unread from my_chats() where id = $1", [chat]))[0].unread).toBe(0);
  });
});

describe("groups", () => {
  it("only with friends, and are deleted when everyone left", async () => {
    await befriend(a, b);
    await expect(rpc(a, "create_group", ["Squad", [b.id, c.id]], ["text", "uuid[]"])).rejects.toThrow(/not_friends/);
    const chat = await rpc<string>(a, "create_group", ["Squad", [b.id]], ["text", "uuid[]"]);
    await say(b, chat);
    expect(await t.as(c, "select * from messages where chat_id = $1", [chat])).toHaveLength(0);
    // b adds their own friend c
    await befriend(b, c);
    await rpc(b, "add_to_group", [chat, c.id], ["uuid", "uuid"]);
    expect(await t.as(c, "select * from messages where chat_id = $1", [chat])).toHaveLength(1);
    for (const who of [a, b, c]) await rpc(who, "leave_group", [chat], ["uuid"]);
    expect(await t.admin("select * from chats where id = $1", [chat])).toHaveLength(0);
  });
});

describe("rooms", () => {
  it("are open to every logged-in player, not to visitors", async () => {
    const pub = await rpc<string>(a, "room", [null], ["uuid"]);
    const gameRoom = await rpc<string>(b, "room", [game.id], ["uuid"]);
    expect(await rpc(c, "room", [null], ["uuid"])).toBe(pub);
    await say(a, gameRoom, "gg");
    expect(await t.as(c, "select body from messages where chat_id = $1", [gameRoom])).toEqual([{ body: "gg" }]);
    await expect(t.as(null, "select * from messages")).rejects.toThrow(/permission denied/);
    await expect(rpc(null, "room", [null], ["uuid"])).rejects.toThrow(/permission denied/);
  });

  it("hide messages from players you blocked", async () => {
    const room = await rpc<string>(a, "room", [game.id], ["uuid"]);
    const m = await say(b, room, "mean words");
    expect((await t.as<{ id: number }>(a, "select id from messages where chat_id = $1", [room])).map((r) => r.id)).toContain(m.id);
    await rpc(a, "block_user", [b.id], ["uuid"]);
    expect((await t.as<{ id: number }>(a, "select id from messages where chat_id = $1", [room])).map((r) => r.id)).not.toContain(m.id);
  });

  it("limit how fast someone can write", async () => {
    const room = await rpc<string>(a, "room", [null], ["uuid"]);
    for (let i = 0; i < 8; i++) await say(a, room, `spam ${i}`);
    await expect(say(a, room)).rejects.toThrow(/rate_limited/);
  });

  it("don't let anyone write as someone else", async () => {
    const room = await rpc<string>(a, "room", [null], ["uuid"]);
    await t.as(a, "insert into messages (chat_id, body) values ($1, 'x')", [room]);
    await expect(t.as(a, "insert into messages (chat_id, body, author_id) values ($1, 'x', $2)", [room, b.id])).rejects.toThrow(/permission denied/);
  });
});

describe("reports and bans", () => {
  it("reach admins, who delete the message and ban the sender", async () => {
    const room = await rpc<string>(a, "room", [null], ["uuid"]);
    const m = await say(b, room, "bad");
    await rpc(a, "report_message", [m.id, "rude"], ["bigint", "text"]);
    expect(await t.as(a, "select * from message_reports")).toHaveLength(0);
    const [r] = await t.as<{ id: number; body: string; reason: string }>(admin, "select * from message_reports where message_id = $1", [m.id]);
    expect(r).toMatchObject({ body: "bad", reason: "rude" });
    await expect(rpc(a, "handle_report", [r.id, "banned", 1], ["bigint", "text", "integer"])).rejects.toThrow(/not_allowed/);
    await rpc(admin, "handle_report", [r.id, "banned", 1], ["bigint", "text", "integer"]);
    expect(await t.admin("select * from messages where id = $1", [m.id])).toHaveLength(0);
    await expect(say(b, room)).rejects.toThrow(/banned/);
    await expect(rpc(b, "send_friend_request", [a.id], ["uuid"])).rejects.toThrow(/banned/);
    await rpc(admin, "ban_user", [b.id, 0], ["uuid", "integer"]);
    await expect(say(b, room)).resolves.toBeDefined();
  });

  it("let players delete their own messages and admins any", async () => {
    const room = await rpc<string>(a, "room", [null], ["uuid"]);
    const mine = await say(a, room);
    const theirs = await say(b, room);
    await t.as(a, "delete from messages where id in ($1, $2)", [mine.id, theirs.id]);
    expect((await t.admin<{ id: number }>("select id from messages where id in ($1, $2)", [mine.id, theirs.id])).map((x) => x.id)).toEqual([theirs.id]);
    await t.as(admin, "delete from messages where id = $1", [theirs.id]);
    expect(await t.admin("select id from messages where id = $1", [theirs.id])).toHaveLength(0);
  });
});

describe("notifications", () => {
  const kinds = async (who: { id: string }) => (await t.as<{ kind: string }>(who, "select kind from notifications order by id")).map((n) => n.kind);

  it("tell players about friend requests and accepts", async () => {
    await befriend(a, b);
    expect(await kinds(b)).toEqual(["friend_request"]);
    expect(await kinds(a)).toEqual(["friend_accept"]);
    expect(await t.as(c, "select * from notifications")).toHaveLength(0);
  });

  it("tell authors about replies and status changes", async () => {
    const [post] = await t.as<{ id: string }>(a, "insert into feedback_posts (game_id, kind, title) values ($1, 'bug', 'It crashes') returning id", [game.id]);
    await t.as(dev, "insert into feedback_replies (post_id, body) values ($1, 'Looking into it')", [post.id]);
    await t.as(dev, "update feedback_posts set status = 'planned' where id = $1", [post.id]);
    await t.as(a, "insert into feedback_replies (post_id, body) values ($1, 'thanks')", [post.id]); // own reply: nothing
    expect(await kinds(a)).toEqual(["fb_reply", "fb_status"]);
  });

  it("can be marked read, and only by their owner", async () => {
    await befriend(a, b);
    await rpc(c, "mark_notifications_read", [null], ["bigint[]"]);
    expect((await t.as<{ read_at: string | null }>(b, "select read_at from notifications"))[0].read_at).toBeNull();
    await rpc(b, "mark_notifications_read", [null], ["bigint[]"]);
    expect((await t.as<{ read_at: string | null }>(b, "select read_at from notifications"))[0].read_at).not.toBeNull();
  });

  it("aren't sent by players you blocked", async () => {
    await rpc(b, "block_user", [a.id], ["uuid"]);
    await rpc(b, "unblock_user", [a.id], ["uuid"]);
    await rpc(b, "block_user", [a.id], ["uuid"]);
    await expect(rpc(a, "send_friend_request", [b.id], ["uuid"])).rejects.toThrow(/blocked/);
    expect(await t.as(b, "select * from notifications")).toHaveLength(0);
  });
});

describe("high scores", () => {
  it("keep each player's best, and tell whoever left the top 3", async () => {
    const g = await t.game(dev);
    expect(await rpc(a, "submit_score", [g.id, 100], ["uuid", "bigint"])).toEqual({ best: 100, new: true });
    expect(await rpc(a, "submit_score", [g.id, 50], ["uuid", "bigint"])).toEqual({ best: 100, new: false });
    await rpc(b, "submit_score", [g.id, 90], ["uuid", "bigint"]);
    await rpc(c, "submit_score", [g.id, 80], ["uuid", "bigint"]);
    const d = await t.user();
    await rpc(d, "submit_score", [g.id, 95], ["uuid", "bigint"]);
    expect(await t.as(c, "select kind from notifications where kind = 'score_beaten'")).toHaveLength(1);
    const board = await t.as<{ rank: number; user_id: string; score: number }>(null, "select rank, user_id, score from leaderboard($1)", [g.id]);
    expect(board.map((r) => [Number(r.rank), r.user_id, Number(r.score)])).toEqual([[1, a.id, 100], [2, d.id, 95], [3, b.id, 90], [4, c.id, 80]]);
  });

  it("can count lower as better, e.g. for times", async () => {
    const g = await t.game(dev);
    await t.admin("update games set score_order = 'low' where id = $1", [g.id]);
    await rpc(a, "submit_score", [g.id, 5000], ["uuid", "bigint"]);
    expect(await rpc(a, "submit_score", [g.id, 4000], ["uuid", "bigint"])).toEqual({ best: 4000, new: true });
    expect(await rpc(a, "submit_score", [g.id, 4500], ["uuid", "bigint"])).toEqual({ best: 4000, new: false });
  });

  it("can't be written directly, only removed by the game's developer", async () => {
    await expect(t.as(a, "insert into game_scores (game_id, user_id, score) values ($1, $2, 9)", [game.id, a.id])).rejects.toThrow(/permission denied/);
    await rpc(a, "submit_score", [game.id, 7], ["uuid", "bigint"]);
    await t.as(b, "delete from game_scores where game_id = $1", [game.id]);
    expect(await t.admin("select * from game_scores where game_id = $1 and user_id = $2", [game.id, a.id])).toHaveLength(1);
    await t.as(dev, "delete from game_scores where game_id = $1 and user_id = $2", [game.id, a.id]);
    expect(await t.admin("select * from game_scores where game_id = $1 and user_id = $2", [game.id, a.id])).toHaveLength(0);
  });
});

describe("ping", () => {
  it("marks the player online and counts unread notifications and chats in one request", async () => {
    await befriend(a, b);
    const chat = await rpc<string>(a, "open_dm", [b.id], ["uuid"]);
    await say(a, chat, "hello");
    await say(a, chat, "are you there?");
    const r = await rpc<{ notifications: number; chats: number }>(b, "ping", [game.id, true], ["uuid", "boolean"]);
    expect(r).toEqual({ notifications: 1, chats: 1 }); // the friend request, and one chat
    expect((await t.admin<{ game_id: string }>("select game_id from presence where user_id = $1", [b.id]))[0].game_id).toBe(game.id);
    await rpc(b, "mark_chat_read", [chat], ["uuid"]);
    await rpc(b, "mark_notifications_read", [null], ["bigint[]"]);
    expect(await rpc(b, "ping", [null, false], ["uuid", "boolean"])).toEqual({ notifications: 0, chats: 0 });
    // Not visible: online status stays as it was.
    expect((await t.admin<{ game_id: string }>("select game_id from presence where user_id = $1", [b.id]))[0].game_id).toBe(game.id);
  });

  it("doesn't count messages from blocked players", async () => {
    await befriend(a, b);
    const g = await rpc<string>(a, "create_group", ["Trio", [b.id]], ["text", "uuid[]"]);
    await befriend(b, c);
    await rpc(b, "add_to_group", [g, c.id], ["uuid", "uuid"]);
    await rpc(c, "mark_chat_read", [g], ["uuid"]);
    await rpc(c, "block_user", [a.id], ["uuid"]);
    await say(a, g, "from a blocked player");
    expect((await rpc<{ chats: number }>(c, "ping", [null, false], ["uuid", "boolean"])).chats).toBe(0);
    await say(b, g, "from a friend");
    expect((await rpc<{ chats: number }>(c, "ping", [null, false], ["uuid", "boolean"])).chats).toBe(1);
  });
});
