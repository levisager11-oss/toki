import { beforeAll, describe, expect, it } from "vitest";
import { levelForXp, xpForLevel } from "../../src/lib/progress";
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
  const list = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, name: `A ${i}` }));
  await t.as(dev, "select public.set_achievements($1, $2::jsonb)", [game.id, JSON.stringify(list)]);
}, 60_000);

type Progress = { xp: number; level: number; tokens: number; xp_today: number; log: { amount: number; reason: string }[] };
const progress = (who: Who) => t.as<{ p: Progress | null }>(who, "select public.my_progress() as p").then((r) => r[0].p);
const unlock = (who: Who, id: string) => t.as(who, "select public.unlock_achievement($1, $2)", [game.id, id]);
const rpc = <T = unknown>(who: Who, sql: string, params: unknown[] = []) => t.as<{ r: T }>(who, `select ${sql} as r`, params).then((r) => r[0].r);
const befriend = async (a: { id: string }, b: { id: string }) =>
  t.admin("insert into friends (user_id, friend_id) values ($1, $2), ($2, $1)", [a.id, b.id]);
const give = (user: string, tokens: number) => t.admin("update player_progress set tokens = $2 where user_id = $1", [user, tokens]);
const start = async (user: string) => t.admin("insert into player_progress (user_id) values ($1) on conflict do nothing", [user]);

describe("levels", () => {
  it("use the same formula in the database and the app", async () => {
    const xps = [0, 1, 99, 100, 101, 249, 250, 2699, 2700, 10_449, 10_450, 123_456, 9_999_999];
    const rows = await t.admin<{ xp: number; level: number }>(
      "select x::bigint as xp, public.level_for_xp(x::bigint) as level from unnest($1::bigint[]) x", [xps]);
    for (const r of rows) expect(r.level).toBe(levelForXp(Number(r.xp)));
    for (let n = 1; n <= 60; n++) {
      const [{ xp }] = await t.admin<{ xp: string }>("select public.xp_for_level($1) as xp", [n]);
      expect(Number(xp)).toBe(xpForLevel(n));
    }
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(10)).toBe(2700);
  });
});

describe("earning XP and tokens", () => {
  it("achievements give 25 XP and 5 tokens, at most 50 tokens a day", async () => {
    const p = await t.user();
    for (let i = 0; i < 12; i++) await unlock(p, `a${i}`);
    const me = await progress(p);
    expect(me!.xp).toBe(300);
    expect(me!.level).toBe(levelForXp(300));
    // 10 achievements' worth of tokens, plus 20 for each level reached
    expect(me!.tokens).toBe(50 + 20 * (me!.level - 1));
    expect(me!.log.some((l) => l.reason === "level")).toBe(true);
    const notes = await t.admin<{ kind: string }>("select kind from notifications where user_id = $1", [p.id]);
    expect(notes.filter((n) => n.kind === "level_up").length).toBe(me!.level - 1);
  });

  it("playtime gives 1 XP a minute, at most 120 a day", async () => {
    const p = await t.user();
    await t.admin("insert into playtime (user_id, game_id, seconds) values ($1, $2, 1799)", [p.id, game.id]);
    expect((await progress(p))!.xp).toBe(29);
    await t.admin("update playtime set seconds = seconds + 61 where user_id = $1", [p.id]);
    expect((await progress(p))!.xp).toBe(31);
    await t.admin("update playtime set seconds = seconds + 18000 where user_id = $1", [p.id]);
    expect((await progress(p))!.xp).toBe(120);
  });

  it("a new best score gives 10 XP, at most 50 a day", async () => {
    const p = await t.user();
    for (let s = 1; s <= 8; s++) await t.as(p, "select public.submit_score($1::uuid, $2::bigint)", [game.id, s]);
    await t.as(p, "select public.submit_score($1::uuid, $2::bigint)", [game.id, 1]); // not a new best
    expect((await progress(p))!.xp).toBe(50);
  });

  it("caps all XP at 600 a day", async () => {
    const p = await t.user();
    for (let i = 0; i < 30; i++) await unlock(p, `a${i}`);
    const me = await progress(p);
    expect(me!.xp).toBe(600);
    expect(me!.xp_today).toBe(600);
  });

  it("starts again the next day", async () => {
    const p = await t.user();
    for (let i = 0; i < 24; i++) await unlock(p, `a${i}`);
    await t.admin("update player_progress set day = day - 1 where user_id = $1", [p.id]);
    for (let i = 24; i < 30; i++) await unlock(p, `a${i}`);
    const me = await progress(p);
    expect(me!.xp).toBe(750);
    expect(me!.xp_today).toBe(150);
  });

  it("Today's game gives 30 XP and 5 tokens plus the streak", async () => {
    const p = await t.user();
    await t.admin("insert into daily_streaks (user_id, streak, best_streak, last_day) values ($1, 4, 4, current_date)", [p.id]);
    const me = await progress(p);
    expect(me!.xp).toBe(30);
    expect(me!.tokens).toBe(5 + 3);
  });

  it("keeps balances private and the tables closed", async () => {
    const p = await t.user();
    await unlock(p, "a0");
    const other = await t.user();
    await expect(t.as(other, "select * from player_progress")).rejects.toThrow(/permission denied/);
    await expect(t.as(other, "select * from token_log")).rejects.toThrow(/permission denied/);
    await expect(t.as(p, "update player_progress set tokens = 9999 where user_id = $1", [p.id])).rejects.toThrow();
    await expect(t.as(p, "select public.award($1, 'daily', 1000, 1000)", [p.id])).rejects.toThrow(/permission denied/);
    await expect(progress(null)).rejects.toThrow(/permission denied/);
    // Levels are public.
    const [look] = await t.as<{ level: number }>(null, "select * from public.player_looks($1)", [[p.id]]);
    expect(look.level).toBe(1);
  });
});

describe("the shop", () => {
  it("sells Toki's cosmetics for tokens, once", async () => {
    const p = await t.user();
    await start(p.id);
    await expect(rpc(p, "public.buy_cosmetic('frame.mint')")).rejects.toThrow(/not_enough_tokens/);
    await give(p.id, 100);
    expect(await rpc(p, "public.buy_cosmetic('frame.mint')")).toBe(60);
    await expect(rpc(p, "public.buy_cosmetic('frame.mint')")).rejects.toThrow(/owned/);
    await expect(rpc(p, "public.buy_cosmetic('nope')")).rejects.toThrow(/not_found/);
    expect((await progress(p))!.log[0]).toMatchObject({ amount: -40, reason: "buy" });
  });

  it("needs the level an item asks for", async () => {
    const p = await t.user();
    await start(p.id);
    await give(p.id, 10_000);
    await expect(rpc(p, "public.buy_cosmetic('frame.rainbow')")).rejects.toThrow(/level/);
  });

  it("lets players wear only what they have, and shows it to everyone", async () => {
    const p = await t.user();
    await start(p.id);
    await give(p.id, 100);
    await expect(rpc(p, "public.equip_cosmetic('frame', 'frame.mint')")).rejects.toThrow(/not_owned/);
    await rpc(p, "public.buy_cosmetic('title.rookie')");
    await expect(rpc(p, "public.equip_cosmetic('frame', 'title.rookie')")).rejects.toThrow(/not_owned/);
    await rpc(p, "public.equip_cosmetic('title', 'title.rookie')");
    const [look] = await t.as<{ title: string }>(null, "select * from public.player_looks($1)", [[p.id]]);
    expect(look.title).toBe("title.rookie");
    await rpc(p, "public.equip_cosmetic('title', null)");
    const [after] = await t.as<{ title: string | null }>(null, "select title from profiles where id = $1", [p.id]);
    expect(after.title).toBeNull();
    // Not by writing the profile.
    await expect(t.as(p, "update profiles set frame = 'frame.rainbow' where id = $1", [p.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(p, "insert into player_cosmetics (user_id, cosmetic_id, how) values ($1, 'frame.neon', 'shop')", [p.id])).rejects.toThrow();
  });

  it("lets admins change prices and stop selling", async () => {
    const p = await t.user();
    await expect(rpc(p, "public.admin_set_cosmetic('title.chill', 1, true)")).rejects.toThrow(/not_allowed/);
    await rpc(admin, "public.admin_set_cosmetic('title.chill', 70, false)");
    await start(p.id);
    await give(p.id, 500);
    await expect(rpc(p, "public.buy_cosmetic('title.chill')")).rejects.toThrow(/not_found/);
    await rpc(admin, "public.admin_set_cosmetic('title.chill', 70, true)");
    expect(await rpc(p, "public.buy_cosmetic('title.chill')")).toBe(430);
    // Leaving the price out keeps it.
    await rpc(admin, "public.admin_set_cosmetic('title.chill', null, true)");
    expect((await t.admin<{ price: number }>("select price from cosmetics where id = 'title.chill'"))[0].price).toBe(70);
  });

  it("lets admins take tokens and cosmetics away", async () => {
    const p = await t.user();
    await start(p.id);
    await give(p.id, 200);
    await rpc(p, "public.buy_cosmetic('frame.mint')");
    await rpc(p, "public.equip_cosmetic('frame', 'frame.mint')");
    expect(await rpc(admin, "public.admin_adjust_tokens($1, -1000)", [p.id])).toBe(0);
    await rpc(admin, "public.admin_take_cosmetic($1, 'frame.mint')", [p.id]);
    const [row] = await t.admin<{ frame: string | null }>("select frame from profiles where id = $1", [p.id]);
    expect(row.frame).toBeNull();
    await expect(rpc(p, "public.admin_adjust_tokens($1, 1000)", [p.id])).rejects.toThrow(/not_allowed/);
  });
});

describe("a game's own cosmetics", () => {
  const LIST = [
    { kind: "frame", name: "Lava ring", name_de: "Lavaring", style: { style: "double", a: "#ff3300", b: "#ffaa00" }, achievement: "a0" },
    { kind: "title", name: "Dragon slayer", style: {}, achievement: "a1" },
  ];

  it("are given with the achievement, also to players who have it already", async () => {
    const early = await t.user();
    await unlock(early, "a0");
    const rows = await t.as<{ id: string }>(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify(LIST)]);
    expect(rows).toHaveLength(2);
    const has = (u: string) => t.admin<{ cosmetic_id: string }>("select cosmetic_id from player_cosmetics where user_id = $1", [u]).then((r) => r.map((x) => x.cosmetic_id));
    expect(await has(early.id)).toEqual([rows[0].id]);
    const later = await t.user();
    await unlock(later, "a1");
    expect(await has(later.id)).toEqual([rows[1].id]);
    // Keeping one by its id keeps it for players; leaving one out deletes it.
    await t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([{ ...LIST[1], id: rows[1].id, name: "Dragon tamer" }])]);
    expect(await has(later.id)).toEqual([rows[1].id]);
    expect(await has(early.id)).toEqual([]);
  });

  it("are only for the game's developer, at most 5, with a look the app can draw", async () => {
    await expect(t.as(otherDev, "select * from public.set_game_cosmetics($1, '[]'::jsonb)", [game.id])).rejects.toThrow(/not_allowed/);
    const many = Array.from({ length: 6 }, () => LIST[1]);
    await expect(t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify(many)])).rejects.toThrow(/too_many/);
    await expect(t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([{ ...LIST[0], achievement: "nope" }])]))
      .rejects.toThrow(/bad_cosmetics/);
    await expect(t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([{ ...LIST[0], style: { style: "ring", a: "red" } }])]))
      .rejects.toThrow();
    await expect(t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([{ ...LIST[0], kind: "stickers" }])]))
      .rejects.toThrow(/bad_cosmetics/);
  });

  it("can't have the looks the shop sells", async () => {
    const set = (item: object) => t.as(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([item])]);
    for (const style of ["glow", "spin", "rainbow"])
      await expect(set({ ...LIST[0], style: { style, a: "#ff3300", b: "#ffaa00" } })).rejects.toThrow(/cosmetics_game_look_check/);
    await expect(set({ kind: "color", name: "Fire", style: { a: "#ff3300", b: "#ffaa00" }, achievement: "a2" })).rejects.toThrow(/cosmetics_game_look_check/);
    await expect(set({ kind: "theme", name: "Night", style: { a: "#111111", b: "#7a5cff", pattern: "stars" }, achievement: "a2" })).rejects.toThrow(/cosmetics_game_look_check/);
    await expect(set({ kind: "color", name: "Fire", style: { a: "#ff3300" }, achievement: "a2" })).resolves.toBeTruthy();
    await expect(set({ kind: "theme", name: "Grass", style: { a: "#1f6f4a", b: "#8fd694", pattern: "dots" }, achievement: "a2" })).resolves.toBeTruthy();
  });

  it("can be reported, and an admin's removal deletes it", async () => {
    const rows = await t.as<{ id: string; ref: string; name: string }>(dev, "select * from public.set_game_cosmetics($1, $2::jsonb)", [game.id, JSON.stringify([LIST[0], { kind: "title", name: "Rude name", style: {}, achievement: "a3" }])]);
    const c = rows.find((r) => r.name === "Rude name")!;
    const reporter = await t.user();
    await t.as(reporter, "select public.report_content('cosmetic', $1, 'harassment', '')", [c.ref]);
    await expect(t.as(dev, "select public.report_content('cosmetic', $1, 'spam', '')", [c.ref])).rejects.toThrow(/not_found/);
    const [rep] = await t.as<{ id: number; title: string; owner_id: string }>(admin, "select id, title, owner_id from content_reports where kind = 'cosmetic' and target = $1", [c.ref]);
    expect(rep.title).toContain("Rude name");
    expect(rep.owner_id).toBe(dev.id);
    await t.as(admin, "select public.handle_content_report($1, 'removed', 'Keep names friendly')", [rep.id]);
    expect(await t.admin("select 1 from cosmetics where id = $1", [c.id])).toEqual([]);
    expect(await t.admin("select 1 from cosmetics where game_id = $1", [game.id])).toHaveLength(1);
  });

  it("can't be bought", async () => {
    const [c] = await t.admin<{ id: string }>("select id from cosmetics where game_id = $1", [game.id]);
    const p = await t.user();
    await start(p.id);
    await give(p.id, 1000);
    await expect(rpc(p, "public.buy_cosmetic($1)", [c.id])).rejects.toThrow(/not_found/);
  });
});

describe("trades", () => {
  let a: { id: string };
  let b: { id: string };
  let stranger: { id: string };
  const offer = (who: Who, to: string, gt: number, gi: string[], wt: number, wi: string[]) =>
    rpc<string>(who, "public.offer_trade($1, $2, $3::text[], $4, $5::text[])", [to, gt, gi, wt, wi]);

  beforeAll(async () => {
    a = await t.user();
    b = await t.user();
    stranger = await t.user();
    await befriend(a, b);
    for (const u of [a, b, stranger]) {
      await start(u.id);
      await give(u.id, 500);
    }
    await rpc(a, "public.buy_cosmetic('frame.mint')");
    await rpc(b, "public.buy_cosmetic('title.rookie')");
  });

  it("wait until trading opens", async () => {
    await expect(offer(a, b.id, 10, [], 0, ["title.rookie"])).rejects.toThrow(/not_yet/);
    await t.admin("create or replace function public.trading_opens() returns timestamptz language sql stable as $$ select now() - interval '1 day' $$");
  });

  it("swap tokens and cosmetics when the friend accepts", async () => {
    await rpc(a, "public.equip_cosmetic('frame', 'frame.mint')");
    const id = await offer(a, b.id, 50, ["frame.mint"], 0, ["title.rookie"]);
    const [note] = await t.admin<{ data: { event: string } }>("select data from notifications where user_id = $1 and kind = 'trade'", [b.id]);
    expect(note.data.event).toBe("offer");
    await expect(rpc(a, "public.answer_trade($1, true)", [id])).rejects.toThrow(/not_found/);
    expect(await rpc(b, "public.answer_trade($1, true)", [id])).toBe("done");
    expect((await progress(a))!.tokens).toBe(460 - 50);
    expect((await progress(b))!.tokens).toBe(480 + 50);
    const owner = (c: string) => t.admin<{ user_id: string }>("select user_id from player_cosmetics where cosmetic_id = $1 and user_id = any($2)", [c, [a.id, b.id]]);
    expect(await owner("frame.mint")).toEqual([{ user_id: b.id }]);
    expect(await owner("title.rookie")).toEqual([{ user_id: a.id }]);
    // What a gave away comes off their profile.
    const [row] = await t.admin<{ frame: string | null }>("select frame from profiles where id = $1", [a.id]);
    expect(row.frame).toBeNull();
    await expect(rpc(b, "public.answer_trade($1, true)", [id])).rejects.toThrow(/closed/);
  });

  it("only between friends, with what each side has", async () => {
    await expect(offer(a, stranger.id, 10, [], 1, [])).rejects.toThrow(/not_friends/);
    await expect(offer(a, b.id, 10, ["frame.neon"], 1, [])).rejects.toThrow(/not_owned/);
    await expect(offer(a, b.id, 10_000, [], 1, [])).rejects.toThrow(/not_enough_tokens/);
    await expect(offer(a, b.id, 0, [], 1, [])).rejects.toThrow(); // giving nothing
    await expect(offer(a, b.id, 0, ["title.rookie"], 0, ["frame.mint"])).resolves.toBeTruthy();
  });

  it("fail when one side no longer has what it offered", async () => {
    const id = await offer(a, b.id, 400, [], 1, []);
    await give(a.id, 10);
    expect(await rpc(b, "public.answer_trade($1, true)", [id])).toBe("failed");
    await give(a.id, 500);
  });

  it("can be declined or taken back", async () => {
    const one = await offer(a, b.id, 5, [], 5, []);
    expect(await rpc(b, "public.answer_trade($1, false)", [one])).toBe("declined");
    const two = await offer(a, b.id, 5, [], 5, []);
    await rpc(a, "public.cancel_trade($1)", [two]);
    await expect(rpc(b, "public.answer_trade($1, true)", [two])).rejects.toThrow(/closed/);
    const mine = await t.as<{ id: string; status: string; mine: boolean }>(a, "select * from public.my_trades()");
    expect(mine.find((x) => x.id === one)).toMatchObject({ status: "declined", mine: true });
    expect(await t.as(stranger, "select * from trades")).toEqual([]);
  });

  it("can't be accepted by a banned player, who can still decline", async () => {
    const one = await offer(a, b.id, 5, [], 5, []);
    const two = await offer(a, b.id, 5, [], 5, []);
    await t.admin("update profiles set banned_until = now() + interval '1 day' where id = $1", [b.id]);
    await expect(rpc(b, "public.answer_trade($1, true)", [one])).rejects.toThrow(/banned/);
    expect(await rpc(b, "public.answer_trade($1, false)", [two])).toBe("declined");
    await t.admin("update profiles set banned_until = null where id = $1", [b.id]);
    await rpc(a, "public.cancel_trade($1)", [one]);
  });

  it("can't include a game's cosmetics", async () => {
    const [c] = await t.admin<{ id: string }>("select id from cosmetics where game_id = $1", [game.id]);
    await t.admin("insert into player_cosmetics (user_id, cosmetic_id, how) values ($1, $2, 'achievement')", [a.id, c.id]);
    await expect(offer(a, b.id, 0, [c.id], 1, [])).rejects.toThrow(/not_owned/);
  });
});

describe("chat stickers", () => {
  it("need the sticker pack", async () => {
    const p = await t.user();
    const room = await rpc<string>(p, "public.room(null::uuid)");
    await expect(t.as(p, "insert into messages (chat_id, body) values ($1, '[sticker:pals/heart]')", [room])).rejects.toThrow(/not_owned/);
    await start(p.id);
    await give(p.id, 100);
    await rpc(p, "public.buy_cosmetic('stickers.pals')");
    await t.as(p, "insert into messages (chat_id, body) values ($1, '[sticker:pals/heart]')", [room]);
  });
});

describe("top players", () => {
  it("lists players by XP, and friends", async () => {
    const top = await t.as<{ rank: string; level: number; xp: string }>(null, "select * from public.top_players(false, 5)");
    expect(top.length).toBeGreaterThan(0);
    expect(Number(top[0].xp)).toBeGreaterThanOrEqual(Number(top[top.length - 1].xp));
    const loner = await t.user();
    const mine = await t.as<{ user_id: string }>(loner, "select * from public.top_players(true, 5)");
    expect(mine.map((r) => r.user_id)).toEqual([loner.id]);
  });
});

describe("top players this week", () => {
  const week = (who: Who | null, friends = false) =>
    t.as<{ rank: string; user_id: string; xp_week: number }>(who, "select * from public.top_players_week($1, 50)", [friends]);
  const earn = (user: string, xp: number) => t.admin("select public.award($1, 'daily', $2, 0)", [user, xp]);

  it("counts this week's XP, and starts again in a new week", async () => {
    const a = await t.user();
    const b = await t.user();
    await earn(a.id, 40);
    await earn(a.id, 10);
    await earn(b.id, 70);
    let rows = await week(null);
    expect(rows.find((r) => r.user_id === a.id)!.xp_week).toBe(50);
    expect(rows.find((r) => r.user_id === b.id)!.xp_week).toBe(70);
    expect(Number(rows.find((r) => r.user_id === b.id)!.rank)).toBeLessThan(Number(rows.find((r) => r.user_id === a.id)!.rank));
    // last week's XP no longer counts
    await t.admin("update player_progress set week = week - 7 where user_id = $1", [a.id]);
    rows = await week(null);
    expect(rows.some((r) => r.user_id === a.id)).toBe(false);
    // and the first award of the new week starts from zero, while all-time XP keeps growing
    await earn(a.id, 5);
    rows = await week(null);
    expect(rows.find((r) => r.user_id === a.id)!.xp_week).toBe(5);
    const [{ xp }] = await t.admin<{ xp: string }>("select xp from player_progress where user_id = $1", [a.id]);
    expect(Number(xp)).toBe(55);
  });

  it("shows friends, and the player's own place", async () => {
    const me = await t.user();
    const pal = await t.user();
    const stranger = await t.user();
    await befriend(me, pal);
    await earn(pal.id, 30);
    await earn(stranger.id, 90);
    const rows = await week(me, true);
    expect(rows.map((r) => r.user_id).sort()).toEqual([me.id, pal.id].sort());
    expect(rows.find((r) => r.user_id === me.id)!.xp_week).toBe(0);
    expect(Number(rows.find((r) => r.user_id === pal.id)!.rank)).toBe(1);
    expect((await week(me)).some((r) => r.user_id === me.id)).toBe(false);
  });

  it("is open to guests like the all-time list", async () => {
    expect((await week(null)).length).toBeGreaterThan(0);
  });
});
