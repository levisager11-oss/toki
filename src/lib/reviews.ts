// Reviews with stars, following developers and the feed (Toki 2.0). The rules live in the
// database: supabase/migrations/20261213090000_reviews_and_feed.sql.
import { supabase } from "./supabase";
import { limitErrorKey } from "./limitValues";

/** How long a player has to play a game before they can review it. */
export const REVIEW_SECONDS = 600;
export const REVIEW_MAX = 1000;

export interface Review {
  id: string;
  game_id: string;
  user_id: string;
  stars: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  reply: string | null;
  reply_by: string | null;
  reply_at: string | null;
  hidden: boolean;
  author: { id: string; username: string; avatar_url: string | null; avatar_seed: string | null } | null;
}

export interface ReviewStatus {
  seconds: number;
  needed: number;
  own: boolean;
  review: Omit<Review, "author"> | null;
}

/** An i18n key for what went wrong, from the server's error. */
export function reviewErrorKey(error: unknown): string {
  const m = (error as { message?: string } | null)?.message ?? "";
  if (m.includes("play_more")) return "rev.err.playMore";
  if (m.includes("own_game")) return "rev.err.own";
  if (m.includes("banned")) return "soc.err.banned";
  if (m.includes("rate_limited")) return limitErrorKey(m) ?? "soc.err.rateLimited";
  return "error";
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export type ReviewSort = "newest" | "highest" | "lowest" | "text" | "unanswered";

/** A game's reviews in an order or filtered (hidden ones only for their author and the developer). */
export async function listReviews(gameId: string, sort: ReviewSort = "newest", limit = 50): Promise<Review[]> {
  let q = supabase
    .from("game_reviews")
    .select("*, author:profiles!game_reviews_user_id_fkey(id, username, avatar_url, avatar_seed)")
    .eq("game_id", gameId);
  if (sort === "text") q = q.neq("body", "");
  if (sort === "unanswered") q = q.is("reply", null);
  if (sort === "highest") q = q.order("stars", { ascending: false });
  if (sort === "lowest") q = q.order("stars", { ascending: true });
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data as unknown as Review[];
}

/** How many visible reviews have no answer from the developer yet. */
export async function countUnanswered(gameId: string): Promise<number> {
  const { count, error } = await supabase
    .from("game_reviews")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .eq("hidden", false)
    .is("reply", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Reviews per star value, 5 down to 1 (hidden ones don't count). */
export const reviewBreakdown = (gameId: string) => rpc<{ stars: number; n: number }[]>("review_breakdown", { p_game: gameId });

export const reviewStatus = (gameId: string) => rpc<ReviewStatus | null>("review_status", { p_game: gameId });
export const saveReview = (gameId: string, stars: number, body: string) => rpc<string>("save_review", { p_game: gameId, p_stars: stars, p_body: body });
export const deleteReview = (gameId: string) => rpc<void>("delete_review", { p_game: gameId });
export const replyReview = (id: string, text: string) => rpc<void>("reply_review", { p_id: id, p_text: text });

/** The average of a game's stars (null without reviews). */
export function averageStars(stats: { reviews?: number; stars?: number } | null | undefined): number | null {
  return stats?.reviews ? (stats.stars ?? 0) / stats.reviews : null;
}

// ---------- following developers ----------

export const followInfo = (devId: string) => rpc<{ followers: number; following: boolean }>("follow_info", { p_dev: devId });
export const followDeveloper = (devId: string, on: boolean) => rpc<void>("follow_developer", { p_dev: devId, p_on: on });

// ---------- the feed ----------

export interface FeedItem {
  kind: "level" | "achievement" | "best" | "cosmetic" | "review" | "new_game" | "release";
  at: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  avatar_seed: string | null;
  game_id: string | null;
  game_slug: string | null;
  game_title: string | null;
  data: {
    level?: number;
    ids?: string[];
    score?: number;
    board?: string;
    id?: string;
    stars?: number;
    version?: string;
    title?: string;
    small?: boolean;
  };
}

export const myFeed = (before?: string) => rpc<FeedItem[]>("my_feed", { p_before: before ?? null, p_limit: 30 });
