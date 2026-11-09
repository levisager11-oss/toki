// Online status and the unread counts for the bell and the chat icon, in one small request
// (ping() in the database) every 2 minutes while Toki is visible, and right after reading a
// chat or notifications. No Realtime connection is needed for this, so the free plan's
// connections are only used while a chat is open.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const EVERY_MS = 2 * 60_000;

interface Badges {
  notifications: number;
  chats: number;
}
let state: Badges = { notifications: 0, chats: 0 };
const listeners = new Set<(b: Badges) => void>();
const set = (next: Badges) => {
  if (next.notifications === state.notifications && next.chats === state.chats) return;
  state = next;
  listeners.forEach((l) => l(state));
};

let loggedIn = false;
let playing: string | null = null;
let running: Promise<void> | null = null;

/** Asks the server now: marks the player online (when Toki is visible) and gets the counts. */
export function refreshBadges(): Promise<void> {
  if (!loggedIn) return Promise.resolve();
  running ??= Promise.resolve(
    supabase.rpc("ping", { p_game: playing, p_here: document.visibilityState === "visible" }),
  )
    .then(({ data }) => {
      const r = data as Partial<Badges> | null;
      if (r && loggedIn) set({ notifications: Number(r.notifications) || 0, chats: Number(r.chats) || 0 });
    }, () => {})
    .finally(() => {
      running = null;
    });
  return running;
}

/** The game page tells which game is open (null when it closes), so friends see it. */
export function setPlaying(gameId: string | null) {
  if (playing === gameId) return;
  playing = gameId;
  refreshBadges();
}

/** For the app: keeps online status and counts up to date while someone is logged in. */
export function useBadgeUpdates(userId: string | undefined) {
  useEffect(() => {
    loggedIn = !!userId;
    if (!userId) {
      set({ notifications: 0, chats: 0 });
      return;
    }
    let last = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      refreshBadges();
    };
    tick();
    const id = setInterval(tick, EVERY_MS);
    // Coming back to Toki after a while: ask at once.
    const onVisible = () => document.visibilityState === "visible" && Date.now() - last > 30_000 && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      loggedIn = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
}

export function useBadges(): Badges {
  const [b, setB] = useState(state);
  useEffect(() => {
    listeners.add(setB);
    setB(state);
    return () => {
      listeners.delete(setB);
    };
  }, []);
  return b;
}
