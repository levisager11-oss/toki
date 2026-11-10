// Online status and the unread counts for the bell and the chat icon, in one small request
// (ping() in the database) every 2 minutes while Toki is visible, and right after reading a
// chat or notifications. No Realtime connection is needed for this, so the free plan's
// connections are only used while a chat is open, or while a friend is online and could
// invite the player to a game: then Toki listens for a nudge ("you got an invite"), so the
// invite pops up right away instead of with the next request. The nudge carries nothing: the
// invite itself always comes from the server (ping).
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const EVERY_MS = 2 * 60_000;

/** A friend's invite into their room in a multiplayer game (the newest unread one of the last minutes). */
export interface GameInvite {
  /** the notification's id */
  id: number;
  game: string;
  code: string;
  from: { id: string; username: string; avatar_url: string | null; avatar_seed: string | null };
}

interface Badges {
  notifications: number;
  chats: number;
  /** Friends on Toki right now (only then can an invite arrive). */
  friendsOnline: number;
  invite: GameInvite | null;
}
const NONE: Badges = { notifications: 0, chats: 0, friendsOnline: 0, invite: null };
let state: Badges = NONE;
const listeners = new Set<(b: Badges) => void>();
const set = (next: Badges) => {
  if (next.notifications === state.notifications && next.chats === state.chats
    && next.friendsOnline === state.friendsOnline && next.invite?.id === state.invite?.id) return;
  state = next;
  listeners.forEach((l) => l(state));
};

function readInvite(v: unknown): GameInvite | null {
  const i = v as Partial<GameInvite> | null;
  if (!i || typeof i.id !== "number" || typeof i.game !== "string" || typeof i.code !== "string" || !i.from?.username) return null;
  return i as GameInvite;
}

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
      const r = data as { notifications?: number; chats?: number; friends_online?: number; invite?: unknown } | null;
      if (r && loggedIn) {
        set({
          notifications: Number(r.notifications) || 0,
          chats: Number(r.chats) || 0,
          friendsOnline: Number(r.friends_online) || 0,
          invite: readInvite(r.invite),
        });
      }
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

/** The pop-up was answered (joined, or "not now"): it goes away at once, not with the next request. */
export function clearInvite() {
  set({ ...state, invite: null });
}

const nudgeChannel = (userId: string) => `invites:${userId}`;

/** Tells a friend's Toki, if it is listening, to look for the invite that was just sent. */
export function nudge(userId: string) {
  const ch = supabase.channel(nudgeChannel(userId));
  // Not subscribed, so this is one small web request instead of a connection.
  Promise.resolve(ch.send({ type: "broadcast", event: "invite", payload: {} }))
    .catch(() => {})
    .finally(() => void supabase.removeChannel(ch));
}

/** For the app: keeps online status and counts up to date while someone is logged in. */
export function useBadgeUpdates(userId: string | undefined) {
  useInviteNudges(userId);
  useEffect(() => {
    loggedIn = !!userId;
    if (!userId) {
      set(NONE);
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

/**
 * Listens for nudges while a friend is online and Toki is visible. If the connection can't be
 * made (e.g. too many at once), invites still pop up with the next regular request.
 */
function useInviteNudges(userId: string | undefined) {
  const listen = useBadges().friendsOnline > 0;
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  useEffect(() => {
    if (!userId || !listen || !visible) return;
    let last = 0;
    const ch = supabase
      .channel(nudgeChannel(userId))
      .on("broadcast", { event: "invite" }, () => {
        // Anyone could send nudges: they only ever lead to one small request every few seconds.
        if (Date.now() - last < 3000) return;
        last = Date.now();
        refreshBadges();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, listen, visible]);
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
