export type Role = "admin" | "creator";

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
  author?: { username: string } | null;
}

export const CATEGORIES = [
  "action", "adventure", "arcade", "horror", "platformer",
  "puzzle", "racing", "shooter", "sports", "strategy", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
