// Game review (admins): approving or declining new games and new game links, and trusting creators.
// Rules: supabase/migrations/20261109190000_game_review.sql
import { supabase } from "./supabase";
import type { Game, GameStatus, Role } from "./types";

export type Submission = Pick<Game, "id" | "slug" | "title" | "category" | "cover" | "thumbnail_url" | "play_url" | "pending_play_url" | "needs_isolation" | "created_by"> & {
  status: GameStatus;
  submitted_at: string;
  author: { username: string; role: Role } | null;
};

/** Tells the menu's counter that the number of games to review changed. */
export const REVIEW_CHANGED = "toki:review-changed";

const FIELDS = "id, slug, title, category, cover, thumbnail_url, play_url, pending_play_url, needs_isolation, created_by, status, submitted_at, author:profiles!games_created_by_fkey(username, role)";
const WAITING = "status.eq.pending,pending_play_url.not.is.null";

/** What waits for review, oldest first. */
export async function reviewQueue(): Promise<Submission[]> {
  const { data, error } = await supabase.from("games").select(FIELDS).or(WAITING).order("submitted_at");
  if (error) throw error;
  return data as unknown as Submission[];
}

/** How many games wait for review (for the admin's menu). */
export async function reviewCount(): Promise<number> {
  const { count, error } = await supabase.from("games").select("id", { count: "exact", head: true }).or(WAITING);
  return error ? 0 : count ?? 0;
}

/** Returns the game's status afterwards. */
export async function reviewGame(gameId: string, approve: boolean, note: string): Promise<GameStatus> {
  const { data, error } = await supabase.rpc("review_game", { p_game: gameId, p_approve: approve, p_note: note.trim() || null });
  if (error) throw error;
  return data as GameStatus;
}

export async function setTrusted(userId: string, trusted: boolean): Promise<Role> {
  const { data, error } = await supabase.rpc("set_trusted", { p_user: userId, p_trusted: trusted });
  if (error) throw error;
  return data as Role;
}

export async function trustedCreators(): Promise<{ id: string; username: string }[]> {
  const { data, error } = await supabase.from("profiles").select("id, username").eq("role", "creator").order("username");
  if (error) throw error;
  return data as { id: string; username: string }[];
}
