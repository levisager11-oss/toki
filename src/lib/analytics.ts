import { useEffect, useRef, type RefObject } from "react";
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
  /** Players with a score on the main board. */
  scores: number;
  /** The game's other boards, and how many players have a score on each (missing on older servers). */
  boards?: { id: string; name: string; name_de: string | null; scores: number }[];
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
 * Time only counts while someone plays: up to this long after the last key, click, touch or
 * controller input. Games with Toki's script (v12 and newer) say when there was input in them.
 */
export const IDLE_MS = 5 * 60_000;
/**
 * Games that don't say so (no script, or an older copy): the page around them only sees the
 * click into the game, input next to it and coming back to the tab, so it waits longer.
 */
export const IDLE_UNSEEN_MS = 30 * 60_000;

/**
 * The time to count for a stretch on screen. Toki looks at least every 10 minutes while a game
 * is on screen, so a longer stretch means the computer slept in between (on some systems the
 * clock runs on while it does): that night isn't playtime, only the time up to the next look.
 */
export function onScreen(ms: number): number {
  return Math.max(0, Math.min(ms, FLUSH_EVERY_MS));
}

/**
 * The part of the stretch from `since` to `now` (ms) that counts: on screen, and no longer
 * than `idle` after the last input. A game left open with nobody at it stops counting.
 */
export function playedIn(since: number, now: number, lastInput: number, idle: number): number {
  return onScreen(Math.min(now, lastInput + idle) - since);
}

/**
 * Counts how long the game is on screen and played (not while the tab is hidden, nor after
 * minutes without input) and sends it to Toki when the player leaves, hides the app, or every
 * 10 minutes. Uses a keepalive request so the time also arrives when the tab is closed.
 */
export function usePlaytime(
  gameId: string | undefined,
  accessToken: string | undefined,
  frame: RefObject<HTMLIFrameElement | null>,
) {
  const token = useRef(accessToken);
  token.current = accessToken;

  useEffect(() => {
    if (!gameId) return;
    let since = document.visibilityState === "visible" ? performance.now() : null;
    let lastInput = performance.now();
    let reports = false; // the game says when there was input in it
    let pending = 0; // ms not sent yet
    let session = 0; // ms on screen in this visit

    const tick = () => {
      if (since === null) return;
      const now = performance.now();
      const ms = playedIn(since, now, lastInput, reports ? IDLE_MS : IDLE_UNSEEN_MS);
      pending += ms;
      session += ms;
      since = now;
    };
    const input = () => {
      tick();
      lastInput = performance.now();
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
        lastInput = since;
      }
    };
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { toki?: unknown; type?: unknown } | null;
      if (!m || m.toki !== 1 || !frame.current || e.source !== frame.current.contentWindow) return;
      if (m.type === "inputs") {
        tick();
        reports = true;
      } else if (m.type === "active") {
        reports = true;
        input();
      }
    };
    // Clicking into the game moves the focus from the page to it.
    const onBlur = () => {
      if (frame.current && document.activeElement === frame.current) input();
    };
    const opts = { capture: true, passive: true };
    const inputs = ["keydown", "pointerdown", "pointermove", "touchstart", "wheel"] as const;
    const timer = setInterval(flush, FLUSH_EVERY_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    for (const name of inputs) window.addEventListener(name, input, opts);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("blur", onBlur);
      for (const name of inputs) window.removeEventListener(name, input, opts);
      flush();
    };
  }, [gameId, frame]);
}

/**
 * Whether a login token can still be used. A login lasts about an hour and is only renewed
 * while Toki is on screen, so after the computer slept, or a tab stayed in the back for long,
 * the one at hand may be over. `now` in milliseconds.
 */
export function tokenUsable(accessToken: string | undefined, now = Date.now()): boolean {
  if (!accessToken) return false;
  try {
    const part = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = (JSON.parse(atob(part)) as { exp?: unknown }).exp;
    // A few seconds early: the request still has to get there.
    return typeof exp === "number" && exp * 1000 > now + 10_000;
  } catch {
    return false;
  }
}

function send(gameId: string, seconds: number, accessToken: string | undefined) {
  const key = import.meta.env.VITE_SUPABASE_KEY as string;
  // With a login that is over the server refuses the whole request and the time is lost.
  // Without one it still counts for the game and this browser, just not for the account.
  const bearer = tokenUsable(accessToken) ? accessToken : key;
  fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/record_playtime`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ p_game: gameId, p_visitor: visitorId(), p_seconds: Math.min(seconds, 86_400) }),
  }).catch(() => {});
}
