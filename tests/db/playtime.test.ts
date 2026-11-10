import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let dev2: { id: string };
let game: { id: string };
let a: { id: string; username: string };
let b: { id: string; username: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  dev2 = await t.user("creator");
}, 60_000);

beforeEach(async () => {
  game = await t.game(dev);
  a = await t.user();
  b = await t.user();
});

const rpc = async <T = unknown>(who: Who, fn: string, args: unknown[] = [], types: string[] = []) => {
  const params = args.map((_, i) => `$${i + 1}${types[i] ? `::${types[i]}` : ""}`).join(", ");
  const rows = await t.as<Record<string, T>>(who, `select ${fn}(${params}) as r`, args);
  return rows[0]?.r as T;
};
const play = (who: Who, visitor: string) => rpc(who, "record_play", [game.id, visitor], ["uuid", "uuid"]);
const time = (who: Who, visitor: string, seconds: number) =>
  rpc<number>(who, "record_playtime", [game.id, visitor, seconds], ["uuid", "uuid", "integer"]);
/** Pretends the last report of this browser (and account) was this many seconds ago. */
const wait = async (visitor: string, seconds: number, who?: { id: string }) => {
  await t.admin("update game_plays set last_at = now() - make_interval(secs => $2) where visitor = $1", [visitor, seconds]);
  if (who) await t.admin("update playtime set last_at = now() - make_interval(secs => $2) where user_id = $1", [who.id, seconds]);
};
type Analytics = {
  plays: number; seconds: number; players: number; active_players: number; scores: number; saves: number;
  open_feedback: number; days: [string, number, number][]; releases: { version: string }[];
};
const analytics = (who: Who, days = 7) => rpc<Analytics>(who, "game_analytics", [game.id, days], ["uuid", "integer"]);

describe("playtime", () => {
  it("never counts more than the time that has passed", async () => {
    const v = crypto.randomUUID();
    await play(null, v);
    await wait(v, 600);
    expect(await time(null, v, 300)).toBe(300);
    // Right after a report, only a minute more can be counted.
    expect(await time(null, v, 5000)).toBe(60);
    await wait(v, 1200);
    expect(await time(null, v, 5000)).toBe(1260);
    const [s] = await t.admin<{ seconds: string }>("select seconds from game_stats where game_id = $1", [game.id]);
    expect(Number(s.seconds)).toBe(1620);
  });

  it("counts a play when time comes in first, but only once", async () => {
    const v = crypto.randomUUID();
    expect(await time(null, v, 30)).toBe(30);
    await play(null, v);
    const [s] = await t.admin<{ plays: number }>("select plays from game_stats where game_id = $1", [game.id]);
    expect(s.plays).toBe(1);
    const [d] = await t.admin<{ plays: number; seconds: string }>("select plays, seconds from game_days where game_id = $1", [game.id]);
    expect({ plays: d.plays, seconds: Number(d.seconds) }).toEqual({ plays: 1, seconds: 30 });
  });

  it("adds up per account, and an account can't collect time faster from new browsers", async () => {
    const v1 = crypto.randomUUID();
    await play(a, v1);
    await wait(v1, 900);
    expect(await time(a, v1, 900)).toBe(900);
    // A fresh browser id right away: the account's last report was just now.
    expect(await time(a, crypto.randomUUID(), 600)).toBe(0);
    const [p] = await t.admin<{ seconds: number }>("select seconds from playtime where user_id = $1", [a.id]);
    expect(p.seconds).toBe(900);
  });

  it("ignores nonsense", async () => {
    expect(await time(null, crypto.randomUUID(), -50)).toBe(0);
    expect(await rpc(null, "record_playtime", [crypto.randomUUID(), crypto.randomUUID(), 50], ["uuid", "uuid", "integer"])).toBe(0);
  });

  it("can't be read or written directly", async () => {
    await expect(t.as(a, "select * from playtime")).rejects.toThrow(/permission denied/);
    await expect(t.as(a, "select * from game_days")).rejects.toThrow(/permission denied/);
    await expect(t.as(null, "insert into game_days (game_id, day, plays) values ($1, current_date, 99)", [game.id])).rejects.toThrow(/permission denied/);
  });
});

describe("game stats page", () => {
  it("is only for the game's developer and admins", async () => {
    expect((await analytics(dev)).plays).toBe(0);
    expect((await analytics(admin)).plays).toBe(0);
    await expect(analytics(dev2)).rejects.toThrow(/not_allowed/);
    await expect(analytics(a)).rejects.toThrow(/not_allowed/);
    await expect(analytics(null)).rejects.toThrow(/permission denied/);
  });

  it("shows plays and time per day for twice the period", async () => {
    const v = crypto.randomUUID();
    await play(b, v);
    await wait(v, 120);
    await time(b, v, 100);
    const s = await analytics(dev, 7);
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)?.slice(1)).toEqual([1, 100]);
    expect(s.days[0].slice(1)).toEqual([0, 0]);
    expect({ plays: s.plays, seconds: Number(s.seconds), players: s.players, active: s.active_players }).toEqual({ plays: 1, seconds: 100, players: 1, active: 1 });
  });

  it("keeps the period between 7 and 365 days", async () => {
    expect((await analytics(dev, 1)).days).toHaveLength(14);
    expect((await analytics(dev, 5000)).days).toHaveLength(730);
  });

  it("also feeds the 30-day lists on My games", async () => {
    const v = crypto.randomUUID();
    await play(null, v);
    await wait(v, 60);
    await time(null, v, 45);
    const rows = await t.as<{ game_id: string; daily: number[]; seconds: number[] }>(dev, "select * from my_game_stats() where game_id = $1", [game.id]);
    expect(rows[0].daily).toHaveLength(30);
    expect(rows[0].daily.at(-1)).toBe(1);
    expect(rows[0].seconds.at(-1)).toBe(45);
  });
});

describe("profile stats", () => {
  it("show total playtime to everyone and the most played games only to friends", async () => {
    const v = crypto.randomUUID();
    await play(b, v);
    await wait(v, 400);
    await time(b, v, 360);
    type P = { stats: { seconds: number; games: number }; most_played?: { game_id: string; seconds: number }[] };
    const guest = await rpc<P>(null, "get_profile", [b.username]);
    expect(guest.stats).toMatchObject({ seconds: 360, games: 1 });
    expect(guest.most_played).toBeUndefined();
    const self = await rpc<P>(b, "get_profile", [b.username]);
    expect(self.most_played).toEqual([{ game_id: game.id, seconds: 360 }]);
  });
});
