// Favorites, recently played and the visitor id live in this browser (no account needed).
// A favorite also counts as a public like. When logged in, favorites follow the account.
import { useCallback, useEffect, useState } from "react";
import { claimLikes, myLikes, setLike } from "./games";
import { cachedGames, invalidateGames, patchGame } from "./useGames";
import type { Game } from "./types";

const FAV_KEY = "toki.favorites";
const RECENT_KEY = "toki.recent";
const SYNCED_KEY = "toki.likesSynced"; // favorites the server already counts as likes
const VISITOR_KEY = "toki.visitor";
const ACCOUNT_KEY = "toki.likesAccount"; // the account whose favorites are in this browser
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let memoryVisitor: string | null = null;

/** Random id for this browser, so a visitor counts once per like and once per day per play. */
export function visitorId(): string {
  try {
    const v = localStorage.getItem(VISITOR_KEY);
    if (v && UUID.test(v)) return v;
    const fresh = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    return (memoryVisitor ??= crypto.randomUUID());
  }
}

function withLikes(g: Game, likes: number): Game {
  return { ...g, stats: { plays: g.stats?.plays ?? 0, likes: Math.max(0, likes) } };
}

function sendLike(game: Pick<Game, "id" | "slug">, on: boolean) {
  setLike(game.id, visitorId(), on).then((n) => {
    if (n === null) return; // offline: syncLikes retries on the next visit
    const synced = read(SYNCED_KEY).filter((s) => s !== game.slug);
    write(SYNCED_KEY, on ? [game.slug, ...synced] : synced);
    patchGame(game.id, (g) => withLikes(g, n));
  });
}

export function useFavorites() {
  const favs = useList(FAV_KEY);
  const toggle = useCallback((game: Pick<Game, "id" | "slug">) => {
    const cur = read(FAV_KEY);
    const on = !cur.includes(game.slug);
    write(FAV_KEY, on ? [game.slug, ...cur] : cur.filter((s) => s !== game.slug));
    patchGame(game.id, (g) => withLikes(g, (g.stats?.likes ?? 0) + (on ? 1 : -1)));
    sendLike(game, on);
  }, []);
  return { favs, isFav: (slug: string) => favs.includes(slug), toggle };
}

/** Sends likes for favorites saved before likes existed, or that failed to send. */
export function syncLikes(games: Game[]) {
  const favs = new Set(read(FAV_KEY));
  const synced = new Set(read(SYNCED_KEY));
  for (const g of games) {
    if (favs.has(g.slug) !== synced.has(g.slug)) sendLike(g, favs.has(g.slug));
  }
}

let accountSync: string | null = null;

/**
 * Makes this browser's favorites the account's likes, so they are the same on every device.
 * Changes made here that never reached the server (offline) are kept and sent.
 * userId null = logged out: the account's favorites leave this browser.
 */
export async function syncAccountLikes(userId: string | null) {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(ACCOUNT_KEY);
  } catch {
    /* storage blocked */
  }
  if (!userId) {
    if (owner) {
      setOwner(null);
      write(FAV_KEY, []);
      write(SYNCED_KEY, []);
    }
    return;
  }
  if (accountSync === userId) return;
  accountSync = userId;
  try {
    if (owner && owner !== userId) {
      // Another account's favorites: don't hand them to this one.
      write(FAV_KEY, []);
      write(SYNCED_KEY, []);
    }
    const moved = await claimLikes(visitorId());
    if (moved === null) return;
    const server = await myLikes();
    if (!server) return;
    const favs = read(FAV_KEY);
    const synced = new Set(read(SYNCED_KEY));
    const favSet = new Set(favs);
    const added = favs.filter((s) => !synced.has(s));
    const removed = new Set([...synced].filter((s) => !favSet.has(s)));
    write(SYNCED_KEY, server);
    write(FAV_KEY, [...added, ...server.filter((s) => !added.includes(s))].filter((s) => !removed.has(s)));
    setOwner(userId);
    if (moved > 0) invalidateGames(); // like counts changed (likes from two devices merged)
    else {
      const games = cachedGames();
      if (games) syncLikes(games);
    }
  } finally {
    accountSync = null;
  }
}

function setOwner(userId: string | null) {
  try {
    if (userId) localStorage.setItem(ACCOUNT_KEY, userId);
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* storage blocked */
  }
}

export function useRecent() {
  return useList(RECENT_KEY);
}

export function markPlayed(slug: string) {
  write(RECENT_KEY, [slug, ...read(RECENT_KEY).filter((s) => s !== slug)].slice(0, 12));
}
