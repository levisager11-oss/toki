import { supabase } from "./supabase";
import type { Game } from "./types";

const SELECT = "*, author:profiles!games_created_by_fkey(username), stats:game_stats(plays, likes)";

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

/** The game at this address: its current slug, or (for links from before a rename) an old one. */
export function findGame(games: Game[] | null | undefined, slug: string): Game | undefined {
  if (!games) return undefined;
  return games.find((g) => g.slug === slug) ?? games.find((g) => g.old_slugs?.includes(slug));
}

export const plays = (g: Game) => g.stats?.plays ?? 0;
export const likes = (g: Game) => g.stats?.likes ?? 0;

/** Search over title, author, engine, category name and description (both languages). Ignores case and accents; every word must match. */
export function matches(g: Game, q: string, categoryName: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([g.title, g.author?.username ?? "", g.engine ?? "", categoryName, g.description ?? "", g.description_de ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

/** Lowercase without accents, so "uber" finds "Über". */
const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

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

// ---------- sorting the game list ----------
export const SORTS = ["new", "popular", "liked", "updated"] as const;
export type Sort = (typeof SORTS)[number];

/**
 * The game list in the chosen order. The list from the server is newest first.
 * "Recently updated" goes by the last posted update; games without one count from when they were added.
 */
export function sortGames(games: Game[], sort: Sort, updates: Map<string, string> = new Map()): Game[] {
  if (sort === "popular") return [...games].sort((a, b) => plays(b) - plays(a));
  if (sort === "liked") return [...games].sort((a, b) => likes(b) - likes(a) || plays(b) - plays(a));
  if (sort === "updated") {
    const at = (g: Game) => Date.parse(updates.get(g.id) ?? g.created_at) || 0;
    return [...games].sort((a, b) => at(b) - at(a));
  }
  return games;
}

