// Unread counts for the bell and the chat icon.
// Notifications arrive live (one Realtime subscription per logged-in player). Unread chat
// messages are counted every minute while Toki is visible, and right after opening a chat.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { myChats, unreadNotifications } from "./social";

interface Badges {
  notifications: number;
  chats: number;
}
let state: Badges = { notifications: 0, chats: 0 };
const listeners = new Set<(b: Badges) => void>();
const set = (change: Partial<Badges>) => {
  state = { ...state, ...change };
  listeners.forEach((l) => l(state));
};

let refreshing: Promise<void> | null = null;
/** Counts again now, e.g. after reading a chat or notifications. */
export function refreshBadges() {
  refreshing ??= Promise.all([
    unreadNotifications().then((n) => set({ notifications: n })),
    myChats().then((c) => set({ chats: c.reduce((n, x) => n + (x.unread > 0 ? 1 : 0), 0) }), () => {}),
  ]).then(() => {}).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** For the layout: keeps the counts up to date while someone is logged in. */
export function useBadgeUpdates(userId: string | undefined) {
  useEffect(() => {
    if (!userId) {
      set({ notifications: 0, chats: 0 });
      return;
    }
    refreshBadges();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => {
        set({ notifications: state.notifications + 1 });
      })
      .subscribe();
    const id = setInterval(() => document.visibilityState === "visible" && refreshBadges(), 60_000);
    const onVisible = () => document.visibilityState === "visible" && refreshBadges();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
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
