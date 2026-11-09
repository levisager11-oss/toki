export type Role = "admin" | "creator" | "player";

/** Every account can add games. Those of untrusted accounts (players) wait for an admin's review. */
export const canCreate = (p: { role: Role } | null | undefined) => !!p;
/** Admins and trusted creators: their games go live without review. */
export const isTrusted = (p: { role: Role } | null | undefined) => p?.role === "admin" || p?.role === "creator";

export type GameStatus = "pending" | "approved" | "rejected";

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
  /** Wide picture (2:1) for the featured banner on the home page. */
  banner_url?: string | null;
  cover: string | null;
  featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  screenshots: string[];
  /** The game only runs with cross-origin isolation (e.g. Godot 4 with threads). Off for most games. */
  needs_isolation?: boolean;
  /** Waiting for review, live, or declined. Missing on old cached data: live. */
  status?: GameStatus;
  /** A new game link waiting for review; the approved play_url stays live until then. */
  pending_play_url?: string | null;
  /** The admin's note from the last review. */
  review_note?: string | null;
  submitted_at?: string;
  author?: { username: string; role?: Role } | null;
  stats?: { plays: number; likes: number } | null;
}

export const CATEGORIES = [
  "action", "adventure", "arcade", "horror", "platformer",
  "puzzle", "racing", "shooter", "sports", "strategy", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
