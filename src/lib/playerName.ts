// The name a player goes by in multiplayer games: their Toki name, unless they chose another one
// in Toki (the invite window, or the notice for guests). Toki tells it to the game
// (toki.onName in toki-save.js), so games don't have to ask for it again.
// Kept on this device per account (and one for guests), so nothing is stored for it on the server.
import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { cleanName } from "./invites";

const KEY = "toki.gameName";
const CHANGED = "toki:game-name";

const keyFor = (userId: string | undefined) => `${KEY}.${userId ?? "guest"}`;

function read(userId: string | undefined): string {
  try {
    return cleanName(localStorage.getItem(keyFor(userId)));
  } catch {
    return "";
  }
}

/**
 * The name to go by and a way to change it. Logged-in players go by their Toki name until they
 * choose another; guests have none until they choose one ("" then). An empty name goes back to
 * the Toki name.
 */
export function usePlayerName(): { name: string; chosen: string; fallback: string; setName: (name: string) => void } {
  const { session, profile } = useAuth();
  const userId = session?.user.id;
  const fallback = profile?.username ?? "";
  const [chosen, setChosen] = useState(() => read(userId));
  useEffect(() => {
    setChosen(read(userId));
    const onChange = () => setChosen(read(userId));
    window.addEventListener(CHANGED, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [userId]);
  const setName = (next: string) => {
    const v = cleanName(next);
    try {
      if (v && v !== fallback) localStorage.setItem(keyFor(userId), v);
      else localStorage.removeItem(keyFor(userId));
    } catch {
      /* no storage: the name lasts for this visit */
    }
    setChosen(v && v !== fallback ? v : "");
    window.dispatchEvent(new Event(CHANGED));
  };
  return { name: chosen || fallback, chosen, fallback, setName };
}
