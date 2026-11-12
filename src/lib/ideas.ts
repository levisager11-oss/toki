// Game ideas: players and developers propose games they miss on Toki ("Missing a game you
// want?" on the home page). Developers see all ideas, discuss them, and one claims an idea
// to build it. The rules (who sees and changes what) live in the database:
// supabase/migrations/20261121090000_game_ideas.sql
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Role } from "./types";
import { limitErrorKey } from "./limitValues";

export type IdeaStatus = "open" | "claimed" | "done";
export const IDEA_STATUSES = ["open", "claimed", "done"] as const;
export const IDEA_LIMITS = { title: 100, body: 2000, reply: 2000 } as const;

export interface GameIdea {
  id: string;
  author_id: string;
  title: string;
  body: string;
  status: IdeaStatus;
  /** The developer who builds it. */
  claimed_by: string | null;
  claimed_at: string | null;
  done_at: string | null;
  game_id: string | null;
  reply_count: number;
  created_at: string;
  updated_at: string;
  author: { username: string; role: Role } | null;
  claimer: { username: string } | null;
  /** The finished game. */
  game: { slug: string; title: string } | null;
}

export interface IdeaReply {
  id: string;
  idea_id: string;
  author_id: string;
  body: string;
  created_at: string;
  author: { username: string; role: Role } | null;
}

const IDEA = "*, author:profiles!game_ideas_author_id_fkey(username, role), claimer:profiles!game_ideas_claimed_by_fkey(username), game:games(slug, title)";
const REPLY = "*, author:profiles!game_idea_replies_author_id_fkey(username, role)";

type Err = { message?: string; code?: string } | null | undefined;

/** An i18n key for what went wrong. */
export function ideaErrorKey(error: Err) {
  const m = error?.message ?? "";
  if (m.includes("rate_limited")) return limitErrorKey(m) ?? ("idea.err.limit" as const);
  if (m.includes("taken")) return "idea.err.taken" as const;
  if (m.includes("bad_game")) return "idea.err.game" as const;
  if (m.includes("banned")) return "idea.err.banned" as const;
  if (error?.code === "23514") return "idea.err.short" as const;
  return "error" as const;
}

export class IdeaError extends Error {
  constructor(readonly key: ReturnType<typeof ideaErrorKey>) {
    super(key);
  }
}
const fail = (error: Err) => new IdeaError(ideaErrorKey(error));

/** Developers get every idea, everyone else their own. Newest activity first. */
export async function listIdeas(): Promise<GameIdea[]> {
  const { data, error } = await supabase.from("game_ideas").select(IDEA).order("updated_at", { ascending: false }).limit(300);
  if (error) throw fail(error);
  return data as GameIdea[];
}

export async function getIdea(id: string): Promise<GameIdea | null> {
  const { data, error } = await supabase.from("game_ideas").select(IDEA).eq("id", id).maybeSingle();
  if (error) throw fail(error);
  return data as GameIdea | null;
}

export async function proposeIdea(title: string, body: string): Promise<GameIdea> {
  const { data, error } = await supabase.from("game_ideas").insert({ title: title.trim(), body: body.trim() }).select(IDEA).single();
  if (error) throw fail(error);
  return data as GameIdea;
}

export async function deleteIdea(id: string): Promise<void> {
  const { error } = await supabase.from("game_ideas").delete().eq("id", id);
  if (error) throw fail(error);
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc(fn, args);
  if (error) throw fail(error);
}
/** "I'll build this." Fails with idea.err.taken when another developer was faster. */
export const claimIdea = (id: string) => rpc("claim_game_idea", { p_idea: id });
/** Gives the idea back, so another developer can take it. */
export const releaseIdea = (id: string) => rpc("release_game_idea", { p_idea: id });
/** The game is on Toki. */
export const finishIdea = (id: string, gameId: string) => rpc("finish_game_idea", { p_idea: id, p_game: gameId });

export async function listIdeaReplies(ideaId: string): Promise<IdeaReply[]> {
  const { data, error } = await supabase.from("game_idea_replies").select(REPLY).eq("idea_id", ideaId).order("created_at");
  if (error) throw fail(error);
  return data as IdeaReply[];
}

export async function addIdeaReply(ideaId: string, body: string): Promise<IdeaReply> {
  const { data, error } = await supabase.from("game_idea_replies").insert({ idea_id: ideaId, body: body.trim() }).select(REPLY).single();
  if (error) throw fail(error);
  return data as IdeaReply;
}

export async function deleteIdeaReply(id: string): Promise<void> {
  const { error } = await supabase.from("game_idea_replies").delete().eq("id", id);
  if (error) throw fail(error);
}

// ---------- the box on the home page: admins can hide it ----------

const BANNER_KEY = "toki.ideaBanner";
function savedBanner(): boolean | null {
  try {
    const v = localStorage.getItem(BANNER_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
// What the last visit knew shows right away; the server is asked once per visit.
let banner: boolean | null = savedBanner();
let asked: Promise<void> | null = null;
const listeners = new Set<(v: boolean | null) => void>();
function setBanner(v: boolean) {
  banner = v;
  try {
    localStorage.setItem(BANNER_KEY, v ? "1" : "0");
  } catch {
    /* only a convenience */
  }
  listeners.forEach((l) => l(v));
}

/** Whether the "Missing a game you want?" box is shown on the home page. null: not known yet. */
export function useIdeaBanner(): boolean | null {
  const [v, setV] = useState(banner);
  useEffect(() => {
    listeners.add(setV);
    setV(banner);
    asked ??= Promise.resolve(supabase.from("site_settings").select("idea_banner").maybeSingle()).then(
      ({ data, error }) => {
        if (!error && data) setBanner((data as { idea_banner: boolean }).idea_banner);
      },
      () => {},
    );
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}

/** Admins: shows or hides the box for everyone. */
export async function saveIdeaBanner(on: boolean): Promise<void> {
  const { data, error } = await supabase.from("site_settings").update({ idea_banner: on }).eq("id", 1).select("idea_banner");
  if (error || !data?.length) throw new IdeaError("error");
  setBanner(on);
}
