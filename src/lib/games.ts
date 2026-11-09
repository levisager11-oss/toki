import { supabase } from "./supabase";
import type { Game } from "./types";

const SELECT = "*, author:profiles!games_created_by_fkey(username, role), stats:game_stats(plays, likes)";

export async function listGames(): Promise<Game[]> {
  const { data, error } = await supabase.from("games").select(SELECT).order("created_at", { ascending: false });
  if (error) throw error;
  return data as Game[];
}

export async function getGame(slug: string): Promise<Game | null> {
  const { data, error } = await supabase.from("games").select(SELECT).eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data as Game | null;
}

export async function recordPlay(gameId: string, visitor: string) {
  await supabase.rpc("record_play", { p_game: gameId, p_visitor: visitor });
}

/** Returns the new like count, or null if the request failed. */
export async function setLike(gameId: string, visitor: string, like: boolean): Promise<number | null> {
  const { data, error } = await supabase.rpc("set_like", { p_game: gameId, p_visitor: visitor, p_like: like });
  return error ? null : (data as number);
}

/** Hands this browser's likes to the logged-in account. Returns how many changed, or null on error. */
export async function claimLikes(visitor: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("claim_likes", { p_visitor: visitor });
  return error ? null : (data as number);
}

/** Slugs of the games the logged-in account likes (newest first), or null on error. */
export async function myLikes(): Promise<string[] | null> {
  const { data, error } = await supabase.rpc("my_likes");
  return error ? null : (data as { slug: string }[]).map((r) => r.slug);
}

/** Plays per day for the last 14 days (oldest first), keyed by game id. */
export async function myGameStats(): Promise<Record<string, number[]>> {
  const { data, error } = await supabase.rpc("my_game_stats");
  if (error) throw error;
  return Object.fromEntries((data as { game_id: string; daily: number[] }[]).map((r) => [r.game_id, r.daily]));
}

/** Approved, so it shows for everyone. Games under review only show for their developer and admins. */
export const isLive = (g: Pick<Game, "status">) => (g.status ?? "approved") === "approved";

export const plays = (g: Game) => g.stats?.plays ?? 0;
export const likes = (g: Game) => g.stats?.likes ?? 0;

/** Lowercase search over title, author, engine and category name. */
export function matches(g: Game, q: string, categoryName: string): boolean {
  if (!q) return true;
  const hay = [g.title, g.author?.username ?? "", g.engine ?? "", categoryName].join(" ").toLowerCase();
  return hay.includes(q.trim().toLowerCase());
}

/** Short number: 950, 1.2k, 12k, 1.3M. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
