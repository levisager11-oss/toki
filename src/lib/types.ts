export type Role = "admin" | "creator" | "player";

/** Creators and admins add games; players only play. */
export const canCreate = (p: { role: Role } | null | undefined) => p?.role === "admin" || p?.role === "creator";

export interface Profile {
  id: string;
  username: string;
  role: Role;
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
  cover: string | null;
  featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  screenshots: string[];
  /** Earlier addresses of the game, newest first. Old links still lead to it. */
  old_slugs?: string[];
  /** The game only runs with cross-origin isolation (e.g. Godot 4 with threads). Off for most games. */
  needs_isolation?: boolean;
  author?: { username: string } | null;
  stats?: { plays: number; likes: number } | null;
}

export const CATEGORIES = [
  "action", "adventure", "arcade", "horror", "platformer",
  "puzzle", "racing", "shooter", "sports", "strategy", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
