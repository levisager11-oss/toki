import { useEffect, useState } from "react";
import { listGames } from "./games";
import type { Game } from "./types";

// Simple shared cache so moving between pages doesn't refetch every time.
let cache: Game[] | null = null;
const listeners = new Set<() => void>();

export function invalidateGames() {
  cache = null;
  listeners.forEach((l) => l());
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
    listGames()
      .then((g) => {
        cache = g;
        if (alive) setGames(g);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [version]);

  return { games, error };
}
