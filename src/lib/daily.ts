// Today's game, daily streaks and this week's best. The rules live in the database:
// supabase/migrations/20261127090000_daily_and_weekly.sql. Days and weeks follow UTC, so
// everyone has the same Today's game at the same time.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { ScoreRow } from "./social";

const DAY_MS = 86_400_000;

/** "2026-11-27": the day (UTC) a moment falls on. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Milliseconds until the next day starts (00:00 UTC), when a new game is picked. */
export function msUntilNextDay(now: Date): number {
  const t = now.getTime();
  return DAY_MS - (((t % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Milliseconds until the next week starts (Monday 00:00 UTC). */
export function msUntilNextWeek(now: Date): number {
  const daysAfterMonday = (now.getUTCDay() + 6) % 7;
  return (6 - daysAfterMonday) * DAY_MS + msUntilNextDay(now);
}

/** "5 h 12 min", "12 min", "< 1 min"; whole days for longer: "3 days". */
export function formatLeft(ms: number, lang: "en" | "de"): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const de = lang === "de";
  if (minutes >= 48 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    return de ? `${days} Tagen` : `${days} days`;
  }
  const min = de ? "Min." : "min";
  const h = de ? "Std." : "h";
  if (minutes < 1) return `< 1 ${min}`;
  if (minutes < 60) return `${minutes} ${min}`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} ${h} ${minutes % 60} ${min}` : `${hours} ${h}`;
}

export interface Streak {
  streak: number;
  best_streak: number;
  /** The last day (UTC, "YYYY-MM-DD") the player played Today's game. */
  last_day: string;
}

/** Days in a row up to now. A streak is still alive until a whole day was missed. */
export function currentStreak(s: Streak | null | undefined, today: string): number {
  if (!s) return 0;
  if (s.last_day === today) return s.streak;
  return s.last_day === dayBefore(today) ? s.streak : 0;
}

/** Whether today's play already counted for the streak. */
export const playedToday = (s: Streak | null | undefined, today: string) => s?.last_day === today;

export function dayBefore(day: string): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS));
}

export interface Daily {
  day: string;
  game_id: string;
  /** The top 3 of today, and the logged-in player's own place after them. */
  top: ScoreRow[];
  /** Players with a score today. */
  players: number;
  streak: Streak | null;
}

// Asked at most every 2 minutes (and again after a score on Today's game), so moving between
// pages doesn't ask every time.
const DAILY_MS = 2 * 60_000;
let cache: { key: string; at: number; data: Promise<Daily | null>; gameId?: string } | null = null;
const listeners = new Set<() => void>();

export function dailyToday(userId: string | undefined): Promise<Daily | null> {
  const key = `${userId ?? ""}|${utcDay(new Date())}`;
  if (!cache || cache.key !== key || Date.now() - cache.at > DAILY_MS) {
    const data = Promise.resolve(supabase.rpc("daily_today")).then(({ data, error }) => {
      if (error) throw error;
      const d = data as Daily | null;
      return d && { ...d, players: Number(d.players), top: d.top.map((r) => ({ ...r, id: r.user_id, rank: Number(r.rank), score: Number(r.score) })) };
    });
    const entry: NonNullable<typeof cache> = { key, at: Date.now(), data };
    cache = entry;
    data.then((d) => (entry.gameId = d?.game_id), () => cache === entry && (cache = null));
  }
  return cache.data;
}

/** Asks again, now for what is on screen (a new day, or an admin chose another game). */
export function refreshDaily() {
  cache = null;
  for (const l of listeners) l();
}

/** After a play or a score: the card asks again next time if it was Today's game. */
export function dailyChanged(gameId: string) {
  if (cache?.gameId === gameId) cache = null;
}

/** Today's game for the home page and game pages. undefined: loading; null: none today. */
export function useDaily(userId: string | undefined): Daily | null | undefined {
  const [d, setD] = useState<Daily | null | undefined>(undefined);
  const [n, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    dailyToday(userId).then((r) => alive && setD(r), () => alive && setD(null));
    return () => {
      alive = false;
    };
  }, [userId, n]);
  return d;
}

/** The current time, again every minute (and when the day ends), for "new game in 5 h". */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      const next = new Date();
      setNow(next);
      if (msUntilNextDay(next) > DAY_MS - 60_000) refreshDaily();
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** This week's ("week") or today's ("day") list of a game, like leaderboard(). */
export async function periodLeaderboard(gameId: string, period: "week" | "day", limit = 10): Promise<ScoreRow[]> {
  const { data, error } = await supabase.rpc("period_leaderboard", { p_game: gameId, p_period: period, p_limit: limit });
  if (error) throw error;
  return (data as ScoreRow[]).map((r) => ({ ...r, id: r.user_id, rank: Number(r.rank), score: Number(r.score) }));
}

/** A player's streak, for their profile. null: never played Today's game. */
export async function playerStreak(userId: string): Promise<Streak | null> {
  const { data, error } = await supabase.from("daily_streaks").select("streak, best_streak, last_day").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as Streak | null) ?? null;
}

// ---------- admins ----------
export interface DailyPlan {
  day: string;
  game_id: string;
  /** chosen by an admin (else picked automatically) */
  chosen: boolean;
}

export async function dailySchedule(): Promise<DailyPlan[]> {
  const { data, error } = await supabase.rpc("daily_schedule");
  if (error) throw error;
  return data as DailyPlan[];
}

/** Chooses the game for a day ("YYYY-MM-DD", today or later). null: pick automatically. */
export async function setDailyGame(day: string, gameId: string | null): Promise<void> {
  const { error } = await supabase.rpc("set_daily_game", { p_day: day, p_game: gameId });
  if (error) throw error;
  if (day === utcDay(new Date())) refreshDaily();
}
