// Online status: while Toki is open and visible, it tells the server every 2 minutes that the
// player is here, and which game they have open. Friends see it on profiles and the friends page.
// One tiny row per player is overwritten, so this costs almost nothing on the free plan.
import { useEffect } from "react";
import { supabase } from "./supabase";

const EVERY_MS = 2 * 60_000;
let playing: string | null = null;
let beat: (() => void) | null = null;

/** The game page tells which game is open (null when it closes). */
export function setPlaying(gameId: string | null) {
  if (playing === gameId) return;
  playing = gameId;
  beat?.();
}

export function usePresence(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    let last = 0;
    const send = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      supabase.rpc("heartbeat", { p_game: playing }).then(() => {}, () => {});
    };
    beat = send;
    send();
    const id = setInterval(send, EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && Date.now() - last > 30_000 && send();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      beat = null;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
}
