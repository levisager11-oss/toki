import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let dev: { id: string };
let otherDev: { id: string };
let admin: { id: string };
let game: { id: string };

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  admin = await t.user("admin");
  game = await t.game(dev);
  await t.as(dev, "select public.set_achievements($1, $2::jsonb)", [game.id, JSON.stringify([{ id: "a", name: "A" }, { id: "b", name: "B" }])]);
}, 60_000);

const rpc = <T = unknown>(who: Who, sql: string, params: unknown[] = []) => t.as<{ r: T }>(who, `select ${sql} as r`, params).then((r) => r[0].r);
const played = (user: string, seconds: number, g = game.id) =>
  t.admin("insert into playtime (user_id, game_id, seconds) values ($1, $2, $3) on conflict (user_id, game_id) do update set seconds = excluded.seconds", [user, g, seconds]);
const review = (who: Who, stars: number, body = "", g = game.id) => rpc<string>(who, "public.save_review($1, $2, $3)", [g, stars, body]);
const stats = () => t.admin<{ reviews: number; stars: number }>("select reviews, stars from game_stats where game_id = $1", [game.id]).then((r) => r[0]);
const befriend = (a: { id: string }, b: { id: string }) => t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [a.id, b.id]);

describe("reviews", () => {
  it("need 10 minutes of playtime, and aren't for one's own game", async () => {
    const p = await t.user();
    await played(p.id, 599);
    await expect(review(p, 5)).rejects.toThrow(/play_more/);
    const status = await rpc<{ seconds: number; needed: number; own: boolean; review: null }>(p, "public.review_status($1)", [game.id]);
    expect(status).toMatchObject({ seconds: 599, needed: 600, own: false, review: null });
    await played(dev.id, 9999);
    await expect(review(dev, 5)).rejects.toThrow(/own_game/);
    await expect(review(null, 5)).rejects.toThrow(/permission denied/);
  });

  it("are one per player and game, can be changed, and count on the game", async () => {
    const a = await t.user();
    const b = await t.user();
    await played(a.id, 600);
    await played(b.id, 700);
    const id = await review(a, 4, "  Fun!  ");
    expect(await review(a, 2, "Less fun")).toBe(id);
    await review(b, 5);
    expect(await stats()).toEqual({ reviews: 2, stars: 7 });
    const [row] = await t.as<{ body: string; edited_at: string | null }>(null, "select body, edited_at from game_reviews where id = $1", [id]);
    expect(row.body).toBe("Less fun");
    expect(row.edited_at).not.toBeNull();
    const [note] = await t.admin<{ data: { stars: number } }>("select data from notifications where user_id = $1 and kind = 'review'", [dev.id]);
    expect(note.data.stars).toBe(4);
    await rpc(b, "public.delete_review($1)", [game.id]);
    expect(await stats()).toEqual({ reviews: 1, stars: 2 });
  });

  it("refuse bad stars and long texts, and nobody writes the table directly", async () => {
    const p = await t.user();
    await played(p.id, 600);
    await expect(review(p, 0)).rejects.toThrow(/bad_review/);
    await expect(review(p, 6)).rejects.toThrow(/bad_review/);
    await expect(review(p, 3, "x".repeat(1001))).rejects.toThrow(/bad_review/);
    await expect(t.as(p, "insert into game_reviews (game_id, user_id, stars) values ($1, $2, 5)", [game.id, p.id])).rejects.toThrow();
  });

  it("get one answer from the game's developer", async () => {
    const p = await t.user();
    await played(p.id, 600);
    const id = await review(p, 3, "Needs more levels");
    await expect(rpc(otherDev, "public.reply_review($1, 'hi')", [id])).rejects.toThrow(/not_allowed/);
    await expect(rpc(p, "public.reply_review($1, 'hi')", [id])).rejects.toThrow(/not_allowed/);
    await rpc(dev, "public.reply_review($1, 'Coming soon!')", [id]);
    const [row] = await t.as<{ reply: string; reply_by: string }>(null, "select reply, reply_by from game_reviews where id = $1", [id]);
    expect(row).toEqual({ reply: "Coming soon!", reply_by: dev.id });
    const notes = await t.admin("select 1 from notifications where user_id = $1 and kind = 'review_reply'", [p.id]);
    expect(notes).toHaveLength(1);
    await rpc(dev, "public.reply_review($1, '')", [id]);
    const [gone] = await t.as<{ reply: string | null }>(null, "select reply from game_reviews where id = $1", [id]);
    expect(gone.reply).toBeNull();
  });

  it("can be reported, and an admin's removal hides them", async () => {
    const p = await t.user();
    const reporter = await t.user();
    await played(p.id, 600);
    const id = await review(p, 1, "mean words");
    const before = await stats();
    await t.as(reporter, "select public.report_content('review', $1, 'harassment', '')", [id]);
    await expect(t.as(p, "select public.report_content('review', $1, 'spam', '')", [id])).rejects.toThrow(/not_found/);
    const [rep] = await t.as<{ id: number; title: string }>(admin, "select id, title from content_reports where kind = 'review' and target = $1", [id]);
    expect(rep.title).toContain("mean words");
    await t.as(admin, "select public.handle_content_report($1, 'removed', 'Be kind')", [rep.id]);
    expect(await t.as(null, "select 1 from game_reviews where id = $1", [id])).toEqual([]);
    expect(await t.as(p, "select 1 from game_reviews where id = $1", [id])).toHaveLength(1); // the author still sees it
    const after = await stats();
    expect(after.reviews).toBe(before.reviews - 1);
  });
});

describe("following developers", () => {
  it("works for developers only, and counts followers", async () => {
    const p = await t.user();
    const other = await t.user();
    await rpc(p, "public.follow_developer($1, true)", [dev.id]);
    await rpc(p, "public.follow_developer($1, true)", [dev.id]);
    await expect(rpc(p, "public.follow_developer($1, true)", [other.id])).rejects.toThrow(/not_developer/);
    expect(await rpc(p, "public.follow_info($1)", [dev.id])).toMatchObject({ following: true });
    expect(await rpc(null, "public.follow_info($1)", [dev.id])).toMatchObject({ following: false });
    expect(await t.as(other, "select * from follows")).toEqual([]);
    await rpc(p, "public.follow_developer($1, false)", [dev.id]);
    expect(await rpc(p, "public.follow_info($1)", [dev.id])).toMatchObject({ following: false });
  });
});

describe("the feed", () => {
  it("shows what friends did, and new games and updates of followed developers", async () => {
    const me = await t.user();
    const friend = await t.user();
    const stranger = await t.user();
    await befriend(me, friend);
    for (const p of [friend, stranger]) {
      await t.as(p, "select public.unlock_achievement($1, 'a')", [game.id]);
      await t.as(p, "select public.unlock_achievement($1, 'b')", [game.id]);
      await t.as(p, "select public.submit_score($1::uuid, 50::bigint)", [game.id]);
    }
    await rpc(me, "public.follow_developer($1, true)", [otherDev.id]);
    const newGame = await t.game(otherDev);
    await t.admin("insert into game_releases (game_id, version, title, notes) values ($1, '1.1', 'More levels', '')", [newGame.id]);

    const feed = await t.as<{ kind: string; user_id: string; data: { ids?: string[] } }>(me, "select * from public.my_feed()");
    const kinds = feed.map((f) => f.kind).sort();
    expect(kinds).toEqual(["achievement", "best", "new_game", "release"]);
    expect(feed.every((f) => f.user_id !== stranger.id)).toBe(true);
    // The day's achievements in a game are one entry.
    expect(feed.find((f) => f.kind === "achievement")!.data.ids!.sort()).toEqual(["a", "b"]);
    // Others can't read it.
    expect(await t.as(stranger, "select * from activity where user_id = $1", [friend.id])).toEqual([]);
    await expect(t.as(null, "select * from public.my_feed()")).rejects.toThrow(/permission denied/);
  });

  it("stays empty for a player who turned it off, and turning it off deletes it", async () => {
    const me = await t.user();
    const shy = await t.user();
    await befriend(me, shy);
    await t.as(shy, "select public.unlock_achievement($1, 'a')", [game.id]);
    expect((await t.as(me, "select * from public.my_feed()")).length).toBeGreaterThan(0);
    await t.as(shy, "update profiles set share_activity = false where id = $1", [shy.id]);
    expect(await t.as(me, "select * from public.my_feed()")).toEqual([]);
    await t.as(shy, "select public.unlock_achievement($1, 'b')", [game.id]);
    expect(await t.admin("select 1 from activity where user_id = $1", [shy.id])).toEqual([]);
  });
});

describe("a copy of your data", () => {
  it("includes the new things", async () => {
    const p = await t.user();
    await played(p.id, 600);
    await review(p, 5, "Great");
    await t.as(p, "select public.unlock_achievement($1, 'a')", [game.id]);
    const [{ d }] = await t.as<{ d: Record<string, unknown[]> }>(p, "select public.export_my_data() as d");
    for (const key of ["level_and_tokens", "token_history", "cosmetics", "trades_offered", "trades_received", "reviews", "following", "activity_for_friends"])
      expect(d).toHaveProperty(key);
    expect(d.reviews).toHaveLength(1);
    expect(d.level_and_tokens).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("let a game with reviews be deleted", async () => {
    const g = await t.game(dev);
    const p = await t.user();
    await played(p.id, 600, g.id);
    await review(p, 4, "nice", g.id);
    await t.admin("delete from games where id = $1", [g.id]);
    expect(await t.admin("select 1 from game_stats where game_id = $1", [g.id])).toEqual([]);
  });

  it("keep a review an admin removed removed, also when it is deleted and written again", async () => {
    const g = await t.game(dev);
    const p = await t.user();
    const reporter = await t.user();
    await played(p.id, 600, g.id);
    const id = await review(p, 1, "mean words", g.id);
    await t.as(reporter, "select public.report_content('review', $1, 'harassment', '')", [id]);
    const [rep] = await t.as<{ id: number }>(admin, "select id from content_reports where kind = 'review' and target = $1", [id]);
    await t.as(admin, "select public.handle_content_report($1, 'removed', '')", [rep.id]);
    await rpc(p, "public.delete_review($1)", [g.id]);
    const [kept] = await t.admin<{ body: string; hidden: boolean }>("select body, hidden from game_reviews where id = $1", [id]);
    expect(kept).toEqual({ body: "", hidden: true });
    await review(p, 1, "mean words again", g.id);
    expect(await t.as(null, "select 1 from game_reviews where game_id = $1", [g.id])).toEqual([]);
  });

  it("tell the developer about a player's review once", async () => {
    const g = await t.game(dev);
    const p = await t.user();
    await played(p.id, 600, g.id);
    for (let i = 0; i < 3; i++) {
      await review(p, 5, "again", g.id);
      await rpc(p, "public.delete_review($1)", [g.id]);
    }
    const notes = await t.admin("select 1 from notifications where user_id = $1 and actor_id = $2 and kind = 'review' and data->>'game' = $3", [dev.id, p.id, g.id]);
    expect(notes).toHaveLength(1);
  });

  it("tell the player about the developer's answer once", async () => {
    const g = await t.game(dev);
    const p = await t.user();
    await played(p.id, 600, g.id);
    const id = await review(p, 3, "ok", g.id);
    for (const text of ["Thanks", "", "Thanks!"]) await rpc(dev, "public.reply_review($1, $2)", [id, text]);
    expect(await t.admin("select 1 from notifications where user_id = $1 and kind = 'review_reply'", [p.id])).toHaveLength(1);
  });
});

describe("the feed's day of achievements", () => {
  it("keeps the newest 10", async () => {
    const p = await t.user();
    for (let i = 1; i <= 12; i++)
      await t.admin("select public.add_activity($1, 'achievement', 'ach:test', null, $2::jsonb, 'ids')", [p.id, JSON.stringify({ ids: [`a${i}`] })]);
    const [row] = await t.admin<{ ids: string[] }>("select data->'ids' as ids from activity where user_id = $1 and key = 'ach:test'", [p.id]);
    expect(row.ids).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 3}`));
  });
});
