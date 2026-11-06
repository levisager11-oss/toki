import { supabase } from "./supabase";
import type { Game } from "./types";

const SELECT = "*, author:profiles!games_created_by_fkey(username)";

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
