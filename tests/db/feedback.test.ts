import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string }; // made the game
let otherDev: { id: string }; // a creator of some other game
let player: { id: string };
let stranger: { id: string };
let game: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  stranger = await t.user();
  game = await t.game(dev);
}, 60_000);

// A new player for each test, so the hourly post limit doesn't add up across tests.
beforeEach(async () => {
  player = await t.user();
});

type Post = { id: string; status: string; hidden: boolean; vote_count: number; reply_count: number; answered: boolean; title: string; author_id: string };

async function post(who: Who, fields: { game_id?: string | null; kind?: string; title?: string; body?: string; private?: boolean } = {}) {
  const f = { game_id: game.id, kind: "bug", title: "Jump does nothing", body: "Pressing space does nothing.", private: false, ...fields };
  const [p] = await t.as<Post>(
    who,
    "insert into feedback_posts (game_id, kind, title, body, private) values ($1, $2, $3, $4, $5) returning *",
    [f.game_id, f.kind, f.title, f.body, f.private],
  );
  return p;
}
const read = async (who: Who, id: string) => (await t.as<Post>(who, "select * from feedback_posts where id = $1", [id]))[0];
const asAdmin = async (id: string) => (await t.admin<Post>("select * from feedback_posts where id = $1", [id]))[0];

describe("posting", () => {
  it("lets visitors read the board, but not post", async () => {
    const p = await post(player);
    expect(await read(null, p.id)).toMatchObject({ id: p.id });
    await expect(post(null)).rejects.toThrow(/permission denied/);
  });

  it("sets the author, status and counts on the server", async () => {
    const p = await post(player, { title: "  Spaces around  " });
    expect(p).toMatchObject({ author_id: player.id, status: "open", hidden: false, vote_count: 0, reply_count: 0, answered: false, title: "Spaces around" });
  });

  it("doesn't let players set fields only the server sets", async () => {
    await expect(t.as(player, "insert into feedback_posts (game_id, kind, title, status) values ($1, 'bug', 'abc', 'done')", [game.id]))
      .rejects.toThrow(/permission denied/);
    await expect(t.as(player, "insert into feedback_posts (game_id, kind, title, author_id) values ($1, 'bug', 'abc', $2)", [game.id, stranger.id]))
      .rejects.toThrow(/permission denied/);
    await expect(t.as(player, "insert into feedback_posts (game_id, kind, title, vote_count) values ($1, 'bug', 'abc', 99)", [game.id]))
      .rejects.toThrow(/permission denied/);
  });

  it("checks the text", async () => {
    await expect(post(player, { title: "ab" })).rejects.toThrow(/check/);
    await expect(post(player, { title: "x".repeat(101) })).rejects.toThrow(/check/);
    await expect(post(player, { body: "x".repeat(4001) })).rejects.toThrow(/check/);
    await expect(post(player, { kind: "rant" })).rejects.toThrow(/check/);
  });

  it("only allows private posts for bug reports", async () => {
    await expect(post(player, { kind: "idea", private: true })).rejects.toThrow(/check/);
  });

  it("takes feedback about Toki itself", async () => {
    const p = await post(player, { game_id: null, kind: "idea", title: "Dark mode toggle" });
    expect(await read(null, p.id)).toMatchObject({ id: p.id });
  });

  it("limits how many posts an account makes in an hour", async () => {
    const spammer = await t.user();
    for (let i = 0; i < 5; i++) await post(spammer, { title: `Post number ${i}` });
    await expect(post(spammer, { title: "One too many" })).rejects.toThrow(/rate_limited/);
  });
});

describe("private and hidden posts", () => {
  it("shows a private bug report only to the reporter, the developer and admins", async () => {
    const p = await post(player, { private: true });
    expect(await read(player, p.id)).toBeDefined();
    expect(await read(dev, p.id)).toBeDefined();
    expect(await read(admin, p.id)).toBeDefined();
    expect(await read(stranger, p.id)).toBeUndefined();
    expect(await read(otherDev, p.id)).toBeUndefined();
    expect(await read(null, p.id)).toBeUndefined();
  });

  it("keeps replies and votes on a private post private", async () => {
    const p = await post(player, { private: true });
    await t.as(dev, "insert into feedback_replies (post_id, body) values ($1, 'Thanks, looking into it')", [p.id]);
    expect(await t.as(stranger, "select * from feedback_replies where post_id = $1", [p.id])).toHaveLength(0);
    expect(await t.as(null, "select * from feedback_replies where post_id = $1", [p.id])).toHaveLength(0);
    expect(await t.as(player, "select * from feedback_replies where post_id = $1", [p.id])).toHaveLength(1);
    await expect(t.as(stranger, "insert into feedback_replies (post_id, body) values ($1, 'me too')", [p.id])).rejects.toThrow(/row-level security/);
    await expect(t.as(stranger, "insert into feedback_votes (post_id) values ($1)", [p.id])).rejects.toThrow(/row-level security/);
  });

  it("lets the developer hide a post from everyone but the author", async () => {
    const p = await post(player);
    await t.as(dev, "update feedback_posts set hidden = true where id = $1", [p.id]);
    expect(await read(stranger, p.id)).toBeUndefined();
    expect(await read(null, p.id)).toBeUndefined();
    expect((await read(player, p.id)).hidden).toBe(true);
    expect(await read(dev, p.id)).toBeDefined();
  });
});

describe("status and editing", () => {
  it("lets the developer change the status, but not the player's words", async () => {
    const p = await post(player);
    const [u] = await t.as<Post>(dev, "update feedback_posts set status = 'planned', title = 'Changed by dev' where id = $1 returning *", [p.id]);
    expect(u).toMatchObject({ status: "planned", title: "Jump does nothing" });
  });

  it("lets the author edit the text, but not the status or visibility", async () => {
    const p = await post(player);
    const [u] = await t.as<Post & { edited_at: string | null }>(
      player, "update feedback_posts set status = 'done', hidden = true, title = 'Jump is broken' where id = $1 returning *", [p.id]);
    expect(u).toMatchObject({ status: "open", hidden: false, title: "Jump is broken" });
    expect(u.edited_at).not.toBeNull();
  });

  it("doesn't let other accounts change a post", async () => {
    const p = await post(player);
    expect(await t.as(stranger, "update feedback_posts set title = 'hacked' where id = $1 returning id", [p.id])).toHaveLength(0);
    expect(await t.as(otherDev, "update feedback_posts set status = 'declined' where id = $1 returning id", [p.id])).toHaveLength(0);
    expect(await asAdmin(p.id)).toMatchObject({ status: "open", title: "Jump does nothing" });
  });

  it("doesn't let anyone change the counts or move a post", async () => {
    const p = await post(player);
    await expect(t.as(player, "update feedback_posts set vote_count = 100 where id = $1", [p.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "update feedback_posts set game_id = null where id = $1", [p.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "update feedback_posts set answered = true where id = $1", [p.id])).rejects.toThrow(/permission denied/);
  });

  it("lets only admins manage feedback about Toki", async () => {
    const p = await post(player, { game_id: null, kind: "idea", title: "More categories" });
    expect(await t.as(dev, "update feedback_posts set status = 'planned' where id = $1 returning id", [p.id])).toHaveLength(0);
    const [u] = await t.as<Post>(admin, "update feedback_posts set status = 'planned' where id = $1 returning *", [p.id]);
    expect(u.status).toBe("planned");
  });

  it("lets admins manage any game's feedback", async () => {
    const p = await post(player);
    const [u] = await t.as<Post>(admin, "update feedback_posts set status = 'declined' where id = $1 returning *", [p.id]);
    expect(u.status).toBe("declined");
  });

  it("lets the author and admins delete a post, not the developer", async () => {
    const a = await post(player);
    const b = await post(player);
    expect(await t.as(dev, "delete from feedback_posts where id = $1 returning id", [a.id])).toHaveLength(0);
    expect(await t.as(stranger, "delete from feedback_posts where id = $1 returning id", [a.id])).toHaveLength(0);
    expect(await t.as(player, "delete from feedback_posts where id = $1 returning id", [a.id])).toHaveLength(1);
    expect(await t.as(admin, "delete from feedback_posts where id = $1 returning id", [b.id])).toHaveLength(1);
  });
});

describe("votes", () => {
  it("counts one vote per account and lets it be taken back", async () => {
    const p = await post(player);
    await t.as(stranger, "insert into feedback_votes (post_id) values ($1)", [p.id]);
    await t.as(dev, "insert into feedback_votes (post_id) values ($1)", [p.id]);
    await expect(t.as(stranger, "insert into feedback_votes (post_id) values ($1)", [p.id])).rejects.toThrow(/duplicate key/);
    expect((await asAdmin(p.id)).vote_count).toBe(2);
    await t.as(stranger, "delete from feedback_votes where post_id = $1", [p.id]);
    expect((await asAdmin(p.id)).vote_count).toBe(1);
  });

  it("doesn't let anyone vote for someone else, or see who voted", async () => {
    const p = await post(player);
    await expect(t.as(stranger, "insert into feedback_votes (post_id, user_id) values ($1, $2)", [p.id, player.id])).rejects.toThrow(/permission denied/);
    await t.as(player, "insert into feedback_votes (post_id) values ($1)", [p.id]);
    expect(await t.as(stranger, "select * from feedback_votes where post_id = $1", [p.id])).toHaveLength(0);
    expect(await t.as(null, "select * from feedback_votes where post_id = $1", [p.id]).catch(() => [])).toHaveLength(0);
    expect(await t.as(player, "select * from feedback_votes where post_id = $1", [p.id])).toHaveLength(1);
    // Deleting someone else's vote does nothing.
    expect(await t.as(stranger, "delete from feedback_votes where post_id = $1 returning post_id", [p.id])).toHaveLength(0);
    expect((await asAdmin(p.id)).vote_count).toBe(1);
  });

  it("doesn't let visitors vote", async () => {
    const p = await post(player);
    await expect(t.as(null, "insert into feedback_votes (post_id) values ($1)", [p.id])).rejects.toThrow(/permission denied/);
  });
});

describe("replies", () => {
  it("marks the developer's replies as official and the post as answered", async () => {
    const p = await post(player);
    const [r1] = await t.as<{ official: boolean }>(stranger, "insert into feedback_replies (post_id, body) values ($1, 'Same here') returning *", [p.id]);
    expect(r1.official).toBe(false);
    expect(await asAdmin(p.id)).toMatchObject({ reply_count: 1, answered: false });
    const [r2] = await t.as<{ official: boolean; id: string }>(dev, "insert into feedback_replies (post_id, body) values ($1, 'Fixed in the next update') returning *", [p.id]);
    expect(r2.official).toBe(true);
    expect(await asAdmin(p.id)).toMatchObject({ reply_count: 2, answered: true });
    // The developer takes their reply back: no longer answered.
    await t.as(dev, "delete from feedback_replies where id = $1", [r2.id]);
    expect(await asAdmin(p.id)).toMatchObject({ reply_count: 1, answered: false });
  });

  it("doesn't let players pretend to be the developer", async () => {
    const p = await post(player);
    await expect(t.as(player, "insert into feedback_replies (post_id, body, official) values ($1, 'Official!', true)", [p.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(player, "insert into feedback_replies (post_id, body, author_id) values ($1, 'hi', $2)", [p.id, dev.id])).rejects.toThrow(/permission denied/);
  });

  it("lets people edit their own replies only", async () => {
    const p = await post(player);
    const [r] = await t.as<{ id: string }>(stranger, "insert into feedback_replies (post_id, body) values ($1, 'first') returning id", [p.id]);
    expect(await t.as(player, "update feedback_replies set body = 'changed' where id = $1 returning id", [r.id])).toHaveLength(0);
    const [u] = await t.as<{ body: string; edited_at: string | null }>(stranger, "update feedback_replies set body = 'second' where id = $1 returning *", [r.id]);
    expect(u.body).toBe("second");
    expect(u.edited_at).not.toBeNull();
  });

  it("lets the developer remove replies on their game, but not other players", async () => {
    const p = await post(player);
    const [r] = await t.as<{ id: string }>(stranger, "insert into feedback_replies (post_id, body) values ($1, 'rude words') returning id", [p.id]);
    expect(await t.as(player, "delete from feedback_replies where id = $1 returning id", [r.id])).toHaveLength(0);
    expect(await t.as(otherDev, "delete from feedback_replies where id = $1 returning id", [r.id])).toHaveLength(0);
    expect(await t.as(dev, "delete from feedback_replies where id = $1 returning id", [r.id])).toHaveLength(1);
  });

  it("doesn't let visitors reply", async () => {
    const p = await post(player);
    await expect(t.as(null, "insert into feedback_replies (post_id, body) values ($1, 'hi')", [p.id])).rejects.toThrow(/permission denied/);
  });

  it("refuses empty replies", async () => {
    const p = await post(player);
    await expect(t.as(player, "insert into feedback_replies (post_id, body) values ($1, '   ')", [p.id])).rejects.toThrow(/check/);
  });
});

describe("clean up", () => {
  it("removes a game's feedback with the game", async () => {
    const g = await t.game(dev);
    const p = await post(player, { game_id: g.id });
    await t.as(stranger, "insert into feedback_votes (post_id) values ($1)", [p.id]);
    await t.admin("delete from games where id = $1", [g.id]);
    expect(await asAdmin(p.id)).toBeUndefined();
  });
});
