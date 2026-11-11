// Achievements: games unlock them with toki.achievement("id") (public/toki-save.js), the game page
// shows them with a small "Achievement unlocked" (src/components/Achievements.tsx). Rules:
// supabase/migrations/20261128090000_achievements.sql; the list's own rules: ./achievementRules.ts.
// Players without an account keep their unlocks in this browser until they log in.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { supabase } from "./supabase";
import { addGuestUnlock, readGuestUnlocks, sentId, type Achievement, type GuestUnlock } from "./achievementRules";
import type { Game } from "./types";

export interface AchievementRow extends Achievement {
  /** how many players have it */
  players: number;
  /** when the viewer got it (null: not yet) */
  mine: string | null;
}

export interface Badge extends Achievement {
  game_id: string;
  unlocked_at: string;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function gameAchievements(gameId: string): Promise<AchievementRow[]> {
  const rows = await rpc<AchievementRow[]>("game_achievement_list", { p_game: gameId });
  return (rows ?? []).map((r) => ({ ...r, players: Number(r.players) }));
}

/** A player's achievements, newest first, and how many they have in all. */
export async function playerAchievements(userId: string, limit = 24): Promise<{ badges: Badge[]; total: number }> {
  const rows = await rpc<(Badge & { total: number })[]>("player_achievements", { p_user: userId, p_limit: limit });
  return { badges: (rows ?? []).map(({ total: _t, ...b }) => b), total: Number(rows?.[0]?.total ?? 0) };
}

/** Sets the game's list (achievements left out are deleted, with their unlocks). */
export const saveAchievements = (gameId: string, list: Achievement[]) =>
  rpc<number>("set_achievements", { p_game: gameId, p_list: list, p_mode: "replace" });

const unlock = (gameId: string, id: string) => rpc<{ new: boolean; at?: string } | null>("unlock_achievement", { p_game: gameId, p_id: id });

// ---------- without an account ----------

const GUEST_KEY = "toki.achievements";

function readGuest(): GuestUnlock[] {
  try {
    return readGuestUnlocks(localStorage.getItem(GUEST_KEY));
  } catch {
    return [];
  }
}
function writeGuest(list: GuestUnlock[]) {
  try {
    if (list.length) localStorage.setItem(GUEST_KEY, JSON.stringify(list));
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage blocked: they just aren't kept */
  }
}

let claiming: string | null = null;
/** After logging in: the unlocks made in this browser without an account go to the account. */
export async function claimGuestAchievements(userId: string | null) {
  if (!userId || claiming === userId) return;
  const list = readGuest();
  if (!list.length) return;
  claiming = userId;
  try {
    await rpc<number>("claim_achievements", { p_list: list });
    writeGuest([]);
  } catch {
    /* offline: next time */
  } finally {
    claiming = null;
  }
}

// ---------- on the game page ----------

/**
 * The game's achievements, and the ones the game unlocks while it's open: it calls
 * toki.achievement(id), toki-save.js passes it on. Only messages from the game's frame and its
 * own site count, and only ids the game has on Toki. Logged-in players get them in their account;
 * without one they are kept in this browser. Each new one shows once (toast), then the next.
 */
export function useAchievements(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, userId: string | undefined) {
  const [rows, setRows] = useState<AchievementRow[] | null>(null);
  const [toasts, setToasts] = useState<AchievementRow[]>([]);
  const rowsRef = useRef<AchievementRow[] | null>(null);
  rowsRef.current = rows;
  // Ids the game sent before the list was loaded, and what handles them once it is.
  const waiting = useRef<string[]>([]);
  const handleRef = useRef<(id: string) => void>(() => {});
  const gameId = game?.id;
  const playUrl = game?.play_url;

  useEffect(() => {
    setRows(null);
    setToasts([]);
    if (!gameId) return;
    let alive = true;
    gameAchievements(gameId).then(
      (r) => {
        if (!alive) return;
        // Without an account, the ones unlocked in this browser count as the viewer's.
        const guest = userId ? [] : readGuest().filter((u) => u.game === gameId);
        setRows(r.map((a) => {
          const g = guest.find((u) => u.id === a.id);
          return g && !a.mine ? { ...a, mine: new Date(g.at).toISOString() } : a;
        }));
      },
      () => alive && setRows([]),
    );
    return () => {
      alive = false;
    };
  }, [gameId, userId]);

  useEffect(() => {
    if (!gameId || !playUrl) return;
    let origin: string;
    try {
      origin = new URL(playUrl).origin;
    } catch {
      return;
    }
    let alive = true;
    // Ones already handled while the game is open.
    const handled = new Set<string>();
    const got = (id: string, at: string, counted: boolean) => {
      if (!alive) return;
      const a = rowsRef.current?.find((r) => r.id === id);
      if (!a) return;
      const now = { ...a, mine: at, players: a.players + (counted ? 1 : 0) };
      setRows((list) => list?.map((r) => (r.id === id ? now : r)) ?? list);
      setToasts((list) => [...list, now]);
    };
    const handle = (id: string) => {
      const list = rowsRef.current;
      if (!list) return void (waiting.current.length < 50 && !waiting.current.includes(id) && waiting.current.push(id));
      const a = list.find((r) => r.id === id);
      if (!a || a.mine || handled.has(id)) return; // not one of the game's, or had it already
      handled.add(id);
      if (!userId) {
        const r = addGuestUnlock(readGuest(), gameId, id, Date.now());
        if (!r.added) return;
        writeGuest(r.list);
        return got(id, new Date().toISOString(), false);
      }
      unlock(gameId, id).then(
        (r) => r?.new && got(id, r.at ?? new Date().toISOString(), true),
        () => handled.delete(id), // try again the next time the game sends it
      );
    };
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1 || m.type !== "achievement") return;
      const id = sentId(m.data);
      if (id) handle(id);
    };
    handleRef.current = handle;
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      waiting.current = [];
      handleRef.current = () => {};
      window.removeEventListener("message", onMessage);
    };
  }, [frame, gameId, playUrl, userId]);

  // Once the list is there: the ids that came before it.
  useEffect(() => {
    if (rows && waiting.current.length) waiting.current.splice(0).forEach((id) => handleRef.current(id));
  }, [rows]);

  // Stable, so the toast's timer isn't restarted whenever the page draws again.
  const next = useCallback(() => setToasts((list) => list.slice(1)), []);
  return { rows, toast: toasts[0] ?? null, next };
}
