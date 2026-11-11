// Boards: a game's high-score lists besides its main one. Games send to one with
// toki.score(points, "id") (public/toki-save.js). Rules: supabase/migrations/20261129090000_boards.sql;
// the list's own rules: ./boardRules.ts.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Board, BoardInput } from "./boardRules";

// One small request per game while the app is open (the game page asks once, the form again after saving).
const cache = new Map<string, Promise<Board[]>>();

/** A game's boards besides the main one, in order. [] when it has none (or the server doesn't know boards yet). */
export function gameBoards(gameId: string): Promise<Board[]> {
  let p = cache.get(gameId);
  if (!p) {
    p = Promise.resolve(
      supabase.from("game_boards").select("id, name, name_de, score_order, score_format").eq("game_id", gameId).order("position").order("id"),
    ).then(({ data, error }) => (error ? [] : ((data ?? []) as Board[])));
    cache.set(gameId, p);
  }
  return p;
}

/** The boards of a game for the game page. undefined: loading. */
export function useBoards(gameId: string | undefined): Board[] | undefined {
  const [state, setState] = useState<{ id: string; boards: Board[] } | null>(null);
  useEffect(() => {
    if (!gameId) return;
    let alive = true;
    gameBoards(gameId).then((b) => alive && setState({ id: gameId, boards: b }));
    return () => {
      alive = false;
    };
  }, [gameId]);
  return state && state.id === gameId ? state.boards : undefined;
}

/**
 * Sets the game's boards (boards left out are deleted, with their scores). An entry with id ""
 * names the main board.
 */
export async function saveBoards(gameId: string, list: BoardInput[]): Promise<number> {
  const { data, error } = await supabase.rpc("set_boards", { p_game: gameId, p_list: list, p_mode: "replace" });
  cache.delete(gameId);
  if (error) throw error;
  return data as number;
}
