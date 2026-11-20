// Toki levels, XP and tokens: the same rules as the database
// (supabase/migrations/20261212090000_toki_tokens.sql), so the app can draw the level bar and say
// what earns what. tests/db/tokens.test.ts checks that both agree.

/** The XP a player needs in all for a level: 25·(n−1)·(n+2). Level 2: 100, level 10: 2700. */
export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return 25 * (n - 1) * (n + 2);
}

/** The level for an amount of XP. */
export function levelForXp(xp: number): number {
  let n = Math.max(1, Math.floor((Math.sqrt(9 + (4 * Math.max(0, xp)) / 25) - 1) / 2));
  while (xpForLevel(n + 1) <= xp) n++;
  while (n > 1 && xpForLevel(n) > xp) n--;
  return n;
}

/** How far a player is into their level: XP into it, XP the level needs, and 0..1. */
export function levelProgress(xp: number): { level: number; into: number; needed: number; share: number } {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const needed = xpForLevel(level + 1) - base;
  const into = Math.max(0, xp - base);
  return { level, into, needed, share: needed ? Math.min(1, into / needed) : 0 };
}

/** What earns what (shown on the shop page). */
export const EARN = {
  /** XP a minute of playtime, and at most this many a day from playtime */
  playXpPerMinute: 1,
  playXpPerDay: 120,
  achievementXp: 25,
  achievementTokens: 5,
  achievementTokensPerDay: 50,
  bestScoreXp: 10,
  bestScoreXpPerDay: 50,
  dailyXp: 30,
  dailyTokens: 5,
  /** one more token for each day of a streak after the first, up to this many */
  streakBonusMax: 10,
  levelTokens: 20,
  xpPerDay: 600,
} as const;
