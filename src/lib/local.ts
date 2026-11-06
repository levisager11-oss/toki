// Favorites and recently played live in this browser only (no account needed).
import { useCallback, useEffect, useState } from "react";

const FAV_KEY = "toki.favorites";
const RECENT_KEY = "toki.recent";
const EVENT = "toki:local";

function read(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function write(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: keep working without saving */
  }
  window.dispatchEvent(new Event(EVENT));
}

function useList(key: string) {
  const [list, setList] = useState<string[]>(() => read(key));
  useEffect(() => {
    const sync = () => setList(read(key));
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  return list;
}

export function useFavorites() {
  const favs = useList(FAV_KEY);
  const toggle = useCallback((slug: string) => {
    const cur = read(FAV_KEY);
    write(FAV_KEY, cur.includes(slug) ? cur.filter((s) => s !== slug) : [slug, ...cur]);
  }, []);
  return { favs, isFav: (slug: string) => favs.includes(slug), toggle };
}

export function useRecent() {
  return useList(RECENT_KEY);
}

export function markPlayed(slug: string) {
  write(RECENT_KEY, [slug, ...read(RECENT_KEY).filter((s) => s !== slug)].slice(0, 12));
}
