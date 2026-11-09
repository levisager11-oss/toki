import { useEffect, useState } from "react";
import { listGames } from "./games";
import { syncLikes } from "./local";
import type { Game } from "./types";

// Simple shared cache so moving between pages doesn't refetch every time.
let cache: Game[] | null = null;
let pending: Promise<Game[]> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const cachedGames = () => cache;

export function invalidateGames() {
  cache = null;
  pending = null;
  notify();
}

/** Change one game in the cache (e.g. a new like count) without refetching. */
export function patchGame(id: string, patch: (g: Game) => Game) {
  if (!cache) return;
  cache = cache.map((g) => (g.id === id ? patch(g) : g));
  notify();
}

function load() {
  pending ??= listGames().then((g) => {
    cache = g;
    syncLikes(g);
    return g;
  });
  return pending;
}

export function useGames() {
  const [games, setGames] = useState<Game[] | null>(cache);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (cache) {
      setGames(cache);
      return;
    }
    load()
      .then((g) => alive && setGames(g))
      .catch(() => {
        pending = null;
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [version]);

  return { games, error };
}
