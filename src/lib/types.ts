export type Role = "admin" | "creator" | "player";

/** Creators and admins add games; players only play. */
export const canCreate = (p: { role: Role } | null | undefined) => p?.role === "admin" || p?.role === "creator";

export interface Profile {
  id: string;
  username: string;
  role: Role;
  bio?: string;
  avatar_url?: string | null;
  avatar_seed?: string | null;
}

export interface Game {
  id: string;
  slug: string;
  title: string;
  description: string;
  description_de: string | null;
  controls: string;
  category: Category;
  engine: string | null;
  play_url: string;
  thumbnail_url: string | null;
  /** Wide picture (2:1) for the featured banner on the home page. */
  banner_url?: string | null;
  cover: string | null;
  featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  screenshots: string[];
  /** Earlier addresses of the game, newest first. Old links still lead to it. */
  old_slugs?: string[];
  /** High scores: is a higher or a lower score better (e.g. a time)? */
  score_order?: "high" | "low";
  /** High scores are points, or a time in milliseconds. */
  score_format?: "points" | "time";
  /** The game only runs with cross-origin isolation (e.g. Godot 4 with threads). Off for most games. */
  needs_isolation?: boolean;
  /** The game's address name when Toki hosts it (<site>.playtoki.app). Only the server sets it. */
  hosted_site?: string | null;
  author?: { username: string } | null;
  stats?: { plays: number; likes: number } | null;
}

export const CATEGORIES = [
  "action", "adventure", "arcade", "horror", "platformer",
  "puzzle", "racing", "shooter", "sports", "strategy", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
