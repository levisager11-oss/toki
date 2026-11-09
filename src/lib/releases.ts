// Release notes: what changed in each version of a game (or of Toki itself), and which
// feedback posts the update fixed. Rules: supabase/migrations/20261109150000_release_notes.sql
import { supabase } from "./supabase";
import type { FeedbackKind, FeedbackStatus } from "./feedback";

export const RELEASE_LIMITS = { version: 20, title: 80, notes: 5000 } as const;

export interface FixedPost {
  id: string;
  title: string;
  kind: FeedbackKind;
}

export interface Release {
  id: string;
  game_id: string | null;
  version: string;
  title: string | null;
  notes: string;
  created_by: string | null;
  published_at: string;
  edited_at: string | null;
  /** The feedback posts this update fixed (only those the viewer may see). */
  fixed: FixedPost[];
}

const RELEASE = "*, fixed:feedback_posts!feedback_posts_fixed_in_fkey(id, title, kind)";

export class ReleaseError extends Error {
  constructor(readonly key: "rel.err.versionTaken" | "error") {
    super(key);
  }
}
const fail = (error: { code?: string }) => new ReleaseError(error.code === "23505" ? "rel.err.versionTaken" : "error");

/** Newest first. gameId null: updates of Toki itself. */
export async function listReleases(gameId: string | null, limit = 50): Promise<Release[]> {
  let q = supabase.from("game_releases").select(RELEASE);
  q = gameId ? q.eq("game_id", gameId) : q.is("game_id", null);
  const { data, error } = await q.order("published_at", { ascending: false }).limit(limit);
  if (error) throw fail(error);
  return data as Release[];
}

export interface ReleaseInput {
  version: string;
  title: string | null;
  notes: string;
}

export async function createRelease(gameId: string | null, r: ReleaseInput): Promise<Release> {
  const { data, error } = await supabase.from("game_releases").insert({ game_id: gameId, ...r }).select(RELEASE).single();
  if (error) throw fail(error);
  return data as Release;
}

export async function updateRelease(id: string, r: ReleaseInput): Promise<Release> {
  const { data, error } = await supabase.from("game_releases").update(r).eq("id", id).select(RELEASE).single();
  if (error) throw fail(error);
  return data as Release;
}

export async function deleteRelease(id: string): Promise<void> {
  const { error } = await supabase.from("game_releases").delete().eq("id", id);
  if (error) throw fail(error);
}

/** Links exactly these posts to the update (they're marked done); others linked before are unlinked. */
export async function setFixes(releaseId: string, postIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_release_fixes", { p_release: releaseId, p_posts: postIds });
  if (error) throw fail(error);
}

export interface Fixable {
  id: string;
  title: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  vote_count: number;
  fixed_in: string | null;
}

/** Posts an update can be linked to: not declined, and not already fixed by another update. Most votes first. */
export async function fixablePosts(gameId: string | null, releaseId?: string): Promise<Fixable[]> {
  let q = supabase.from("feedback_posts").select("id, title, kind, status, vote_count, fixed_in");
  q = gameId ? q.eq("game_id", gameId) : q.is("game_id", null);
  q = q.neq("status", "declined").eq("hidden", false);
  q = releaseId ? q.or(`fixed_in.is.null,fixed_in.eq.${releaseId}`) : q.is("fixed_in", null);
  const { data, error } = await q.order("vote_count", { ascending: false }).limit(100);
  if (error) throw fail(error);
  return data as Fixable[];
}

export type NoteBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

/** Splits release notes into paragraphs and lists: lines starting with "-", "*" or "•" are list items. Text only, no HTML. */
export function noteBlocks(notes: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  for (const raw of notes.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const item = /^[-*•]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.type === "ul") last.items.push(item[1]);
      else blocks.push({ type: "ul", items: [item[1]] });
    } else if (!line) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** A guess for the next version: "1.2" → "1.3", "v0.9.4" → "v0.9.5". Empty when there's no number to count up. */
export function nextVersion(last: string | undefined): string {
  const m = last ? /^(.*?)(\d+)(\D*)$/.exec(last.trim()) : null;
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : "";
}
