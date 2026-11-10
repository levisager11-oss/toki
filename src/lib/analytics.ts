import { useEffect, useRef } from "react";
import { supabase } from "./supabase";
import { visitorId } from "./local";

/** One day on a game's stats page: [date "YYYY-MM-DD", plays, seconds played]. */
export type Day = [string, number, number];

export interface GameAnalytics {
  plays: number;
  likes: number;
  seconds: number;
  /** Accounts that ever played the game, and those that played in the chosen period. */
  players: number;
  active_players: number;
  scores: number;
  saves: number;
  open_feedback: number;
  open_bugs: number;
  /** Twice the chosen period, oldest first: the period before, then the period itself. */
  days: Day[];
  releases: { version: string; day: string }[];
}

export async function gameAnalytics(gameId: string, days: number): Promise<GameAnalytics> {
  const { data, error } = await supabase.rpc("game_analytics", { p_game: gameId, p_days: days });
  if (error) throw error;
  return data as GameAnalytics;
}

/** "12 min", "3 h 20 min", "140 h". Under a minute: "< 1 min". */
export function formatDuration(seconds: number, lang: "en" | "de"): string {
  const min = lang === "de" ? "Min." : "min";
  const h = lang === "de" ? "Std." : "h";
  const m = Math.floor(seconds / 60);
  if (m < 1) return seconds > 0 ? `< 1 ${min}` : `0 ${min}`;
  if (m < 60) return `${m} ${min}`;
  const hours = Math.floor(m / 60);
  if (hours >= 100) return `${hours.toLocaleString(lang === "de" ? "de-CH" : "en")} ${h}`;
  return m % 60 ? `${hours} ${h} ${m % 60} ${min}` : `${hours} ${h}`;
}

// Time only counts once the visit counts as a play (the game page waits 10 seconds too).
const MIN_SESSION_S = 10;
// While a game stays open, the time so far goes up this often (otherwise when leaving).
const FLUSH_EVERY_MS = 10 * 60_000;

/**
 * Counts how long the game is on screen (not while the tab is hidden) and sends it to Toki
 * when the player leaves, hides the app, or every 10 minutes. Uses a keepalive request so
 * the time also arrives when the tab is closed.
 */
export function usePlaytime(gameId: string | undefined, accessToken: string | undefined) {
  const token = useRef(accessToken);
  token.current = accessToken;

  useEffect(() => {
    if (!gameId) return;
    let since = document.visibilityState === "visible" ? performance.now() : null;
    let pending = 0; // ms not sent yet
    let session = 0; // ms on screen in this visit

    const tick = () => {
      if (since === null) return;
      const now = performance.now();
      pending += now - since;
      session += now - since;
      since = now;
    };
    const flush = () => {
      tick();
      const seconds = Math.floor(pending / 1000);
      if (seconds < 1 || session < MIN_SESSION_S * 1000) return;
      pending -= seconds * 1000;
      send(gameId, seconds, token.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
        since = null;
      } else if (since === null) {
        since = performance.now();
      }
    };
    const timer = setInterval(flush, FLUSH_EVERY_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [gameId]);
}

function send(gameId: string, seconds: number, accessToken: string | undefined) {
  const key = import.meta.env.VITE_SUPABASE_KEY as string;
  fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/record_playtime`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${accessToken ?? key}` },
    body: JSON.stringify({ p_game: gameId, p_visitor: visitorId(), p_seconds: Math.min(seconds, 86_400) }),
  }).catch(() => {});
}
