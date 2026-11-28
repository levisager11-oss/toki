// A shared high score: "/game/<slug>?by=<username>" shows that player's best score of the game
// (main board) in the link preview, as a picture made by api/score-card. Everything here is public
// anyway (high scores and usernames are on every game's page), read with the public key.
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";
import { formatScore } from "../src/lib/scoreFormat.js";

export interface SharedScore {
  slug: string;
  title: string;
  username: string;
  score: number;
  /** The score as players read it, e.g. "12,345" or "1:02.345". */
  shown: string;
  /** Place on the game's main board, 1 = best. */
  rank: number;
  /** Pictures of the game, best first (screenshots, then banner and cover). */
  images: string[];
}

/** Usernames as Toki allows them; anything else is not looked up. */
export const USERNAME = /^[A-Za-z0-9_.-]{1,32}$/;

async function rows<T>(query: string, headers: Record<string, string> = {}): Promise<{ data: T[]; total: number | null } | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: { apikey: SUPABASE_KEY, ...headers } });
  if (!res.ok) return null;
  const range = res.headers.get("content-range"); // "0-0/12" with Prefer: count=exact
  const total = range && /\/(\d+)$/.test(range) ? Number(range.split("/")[1]) : null;
  return { data: (await res.json()) as T[], total };
}

/** Pictures that link previews can show: no GIFs or WebP (the card renderer can't draw them). */
export function stillImages(g: { screenshots?: string[] | null; banner_url?: string | null; thumbnail_url?: string | null }): string[] {
  const all = [...(g.screenshots ?? []), g.banner_url, g.thumbnail_url].filter((u): u is string => !!u && /^https:\/\//.test(u));
  return all.filter((u) => /\.(png|jpe?g)(\?.*)?$/i.test(u));
}

/** The player's best score of a game, or null when there is none (or the name is not a username). */
export async function sharedScore(slug: string, username: string): Promise<SharedScore | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug) || !USERNAME.test(username)) return null;
  const [games, people] = await Promise.all([
    rows<{ id: string; slug: string; title: string; score_format: "points" | "time"; score_order: "high" | "low"; screenshots: string[] | null; banner_url: string | null; thumbnail_url: string | null }>(
      `games?slug=eq.${encodeURIComponent(slug)}&select=id,slug,title,score_format,score_order,screenshots,banner_url,thumbnail_url`,
    ),
    rows<{ id: string; username: string }>(`profiles?username=eq.${encodeURIComponent(username)}&select=id,username`),
  ]);
  const g = games?.data[0];
  const p = people?.data[0];
  if (!g || !p) return null;
  const mine = await rows<{ score: number }>(`game_scores?game_id=eq.${g.id}&user_id=eq.${p.id}&board=eq.&select=score`);
  const score = mine?.data[0]?.score;
  if (score === undefined || score === null) return null;
  // Place: how many scores are better, plus one.
  const better = await rows<{ user_id: string }>(
    `game_scores?game_id=eq.${g.id}&board=eq.&score=${g.score_order === "low" ? "lt" : "gt"}.${score}&select=user_id&limit=1`,
    { Prefer: "count=exact" },
  );
  return {
    slug: g.slug,
    title: g.title,
    username: p.username,
    score,
    shown: formatScore(score, g.score_format, "en"),
    rank: (better?.total ?? 0) + 1,
    images: stillImages(g),
  };
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st" … */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** The link preview text for a shared score. */
export function scoreHeadline(s: SharedScore) {
  return {
    title: `@${s.username} scored ${s.shown} in ${s.title}`,
    description: `${ordinal(s.rank)} place on the leaderboard. Can you beat it? Play ${s.title} free in your browser on Toki, no download needed.`,
  };
}
