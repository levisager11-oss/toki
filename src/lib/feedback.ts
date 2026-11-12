// Player feedback: bug reports and ideas for Toki and for each game, with replies, votes and a status.
// The rules (who sees and changes what) live in the database:
// supabase/migrations/20261109120000_feedback.sql
import { supabase } from "./supabase";
import type { Role } from "./types";
import { limitErrorKey, type LimitErrorKey } from "./limitValues";

export const KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof KINDS)[number];
export const STATUSES = ["open", "planned", "in_progress", "done", "declined"] as const;
export type FeedbackStatus = (typeof STATUSES)[number];
/** Which posts a list shows: still being worked on, finished, or all. */
export type StatusFilter = "active" | "closed" | "all";
export type Sort = "top" | "new";

const ACTIVE: FeedbackStatus[] = ["open", "planned", "in_progress"];
const CLOSED: FeedbackStatus[] = ["done", "declined"];
export const isClosed = (s: FeedbackStatus) => CLOSED.includes(s);

export const LIMITS = { title: 100, body: 4000, reply: 2000 } as const;
export const PAGE = 30;

export interface FeedbackPost {
  id: string;
  game_id: string | null;
  author_id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  device: string | null;
  private: boolean;
  status: FeedbackStatus;
  hidden: boolean;
  answered: boolean;
  vote_count: number;
  reply_count: number;
  created_at: string;
  edited_at: string | null;
  status_at: string;
  updated_at: string;
  author: { username: string; role: Role } | null;
  game: { slug: string; title: string; created_by: string | null } | null;
  /** The update that fixed (or did) this post. */
  fixed_in: string | null;
  release: { id: string; version: string } | null;
}

export interface FeedbackReply {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  official: boolean;
  created_at: string;
  edited_at: string | null;
  author: { username: string; role: Role } | null;
}

const POST = "*, author:profiles!feedback_posts_author_id_fkey(username, role), game:games(slug, title, created_by), release:game_releases!feedback_posts_fixed_in_fkey(id, version)";
const REPLY = "*, author:profiles!feedback_replies_author_id_fkey(username, role)";

/** An i18n key for what went wrong. */
export function errorKey(error: { message?: string; code?: string } | null | undefined): LimitErrorKey | "fb.err.rateLimited" | "fb.err.tooShort" | "error" {
  const m = error?.message ?? "";
  if (m.includes("rate_limited")) return limitErrorKey(m) ?? "fb.err.rateLimited";
  if (error?.code === "23514") return "fb.err.tooShort";
  return "error";
}

export class FeedbackError extends Error {
  constructor(readonly key: ReturnType<typeof errorKey>) {
    super(key);
  }
}
const fail = (error: { message?: string; code?: string }) => new FeedbackError(errorKey(error));

export interface ListOptions {
  /** A game's id, or null for feedback about Toki itself. */
  gameId: string | null;
  kind?: FeedbackKind;
  status?: StatusFilter;
  sort?: Sort;
  offset?: number;
}

export async function listPosts({ gameId, kind, status = "active", sort = "top", offset = 0 }: ListOptions): Promise<FeedbackPost[]> {
  let q = supabase.from("feedback_posts").select(POST);
  q = gameId ? q.eq("game_id", gameId) : q.is("game_id", null);
  if (kind) q = q.eq("kind", kind);
  if (status !== "all") q = q.in("status", status === "active" ? ACTIVE : CLOSED);
  if (sort === "top") q = q.order("vote_count", { ascending: false });
  const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + PAGE - 1);
  if (error) throw fail(error);
  return data as FeedbackPost[];
}

/** How many posts about this game are still being worked on. */
export async function countActive(gameId: string): Promise<number> {
  const { count, error } = await supabase
    .from("feedback_posts")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .in("status", ACTIVE);
  if (error) throw fail(error);
  return count ?? 0;
}

export async function getPost(id: string): Promise<FeedbackPost | null> {
  const { data, error } = await supabase.from("feedback_posts").select(POST).eq("id", id).maybeSingle();
  if (error) throw fail(error);
  return data as FeedbackPost | null;
}

export interface NewPost {
  game_id: string | null;
  kind: FeedbackKind;
  title: string;
  body: string;
  device: string | null;
  private: boolean;
}

export async function createPost(p: NewPost): Promise<FeedbackPost> {
  const { data, error } = await supabase.from("feedback_posts").insert(p).select(POST).single();
  if (error) throw fail(error);
  return data as FeedbackPost;
}

export type PostChange = Partial<Pick<FeedbackPost, "kind" | "title" | "body" | "private" | "status" | "hidden">>;

export async function updatePost(id: string, change: PostChange): Promise<FeedbackPost> {
  const { data, error } = await supabase.from("feedback_posts").update(change).eq("id", id).select(POST).single();
  if (error) throw fail(error);
  return data as FeedbackPost;
}

export async function deletePost(id: string): Promise<void> {
  const { error } = await supabase.from("feedback_posts").delete().eq("id", id);
  if (error) throw fail(error);
}

export async function listReplies(postId: string): Promise<FeedbackReply[]> {
  const { data, error } = await supabase.from("feedback_replies").select(REPLY).eq("post_id", postId).order("created_at");
  if (error) throw fail(error);
  return data as FeedbackReply[];
}

export async function addReply(postId: string, body: string): Promise<FeedbackReply> {
  const { data, error } = await supabase.from("feedback_replies").insert({ post_id: postId, body }).select(REPLY).single();
  if (error) throw fail(error);
  return data as FeedbackReply;
}

export async function updateReply(id: string, body: string): Promise<FeedbackReply> {
  const { data, error } = await supabase.from("feedback_replies").update({ body }).eq("id", id).select(REPLY).single();
  if (error) throw fail(error);
  return data as FeedbackReply;
}

export async function deleteReply(id: string): Promise<void> {
  const { error } = await supabase.from("feedback_replies").delete().eq("id", id);
  if (error) throw fail(error);
}

/** Which of these posts the logged-in account voted for. The database only shows an account its own votes. */
export async function myVotes(postIds: string[]): Promise<Set<string>> {
  if (!postIds.length) return new Set();
  const { data, error } = await supabase.from("feedback_votes").select("post_id").in("post_id", postIds);
  if (error) return new Set();
  return new Set((data as { post_id: string }[]).map((v) => v.post_id));
}

export async function setVote(postId: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from("feedback_votes").insert({ post_id: postId })
    : await supabase.from("feedback_votes").delete().eq("post_id", postId);
  // 23505: already voted (e.g. from another tab), which is what we wanted.
  if (error && error.code !== "23505") throw fail(error);
}

/** Feedback for the developer's dashboard: their games' posts, or for admins everything. Newest activity first. */
export async function inboxPosts(gameIds: string[] | "all"): Promise<FeedbackPost[]> {
  if (gameIds !== "all" && !gameIds.length) return [];
  let q = supabase.from("feedback_posts").select(POST);
  if (gameIds !== "all") q = q.in("game_id", gameIds);
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(500);
  if (error) throw fail(error);
  return data as FeedbackPost[];
}

/** The logged-in account's own posts, newest activity first. */
export async function myPosts(userId: string): Promise<FeedbackPost[]> {
  const { data, error } = await supabase
    .from("feedback_posts")
    .select(POST)
    .eq("author_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw fail(error);
  return data as FeedbackPost[];
}

/** Whether this account looks after the post: the game's developer, or an admin (for every post). */
export function canManage(post: Pick<FeedbackPost, "game">, me: { id: string; role: Role } | null | undefined): boolean {
  if (!me) return false;
  return me.role === "admin" || (!!post.game && post.game.created_by === me.id);
}

/** Where a post's update is described: the game's updates page, or Toki's. */
export const releaseUrl = (p: Pick<FeedbackPost, "game" | "release">) =>
  p.release ? `${p.game ? `/game/${p.game.slug}/updates` : "/updates"}#r-${p.release.id}` : "";

/** Posts that wait for the developer: still being worked on and not answered yet. */
export const needsReply = (p: FeedbackPost) => !p.answered && !isClosed(p.status) && !p.hidden;

export interface Summary {
  needsReply: number;
  bugs: number;
  ideas: number;
  done: number;
}

export function summarize(posts: FeedbackPost[]): Summary {
  const s: Summary = { needsReply: 0, bugs: 0, ideas: 0, done: 0 };
  for (const p of posts) {
    if (p.hidden) continue;
    if (needsReply(p)) s.needsReply++;
    if (p.status === "done") s.done++;
    else if (!isClosed(p.status)) {
      if (p.kind === "bug") s.bugs++;
      else if (p.kind === "idea") s.ideas++;
    }
  }
  return s;
}

/** Short description of the browser, e.g. "Safari 18 · iOS 18.1 · 390×844", attached to bug reports. */
export function deviceSummary(ua: string, width?: number, height?: number): string {
  const m = (re: RegExp) => re.exec(ua);
  let os = "";
  let v: RegExpExecArray | null;
  if ((v = m(/(?:iPhone|iPad|iPod).*? OS (\d+)(?:_(\d+))?/))) os = `iOS ${v[1]}${v[2] ? `.${v[2]}` : ""}`;
  else if ((v = m(/Android (\d+(?:\.\d+)?)/))) os = `Android ${v[1]}`;
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  const browsers: [string, RegExp][] = [
    ["Edge", /Edg(?:A|iOS)?\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:CriOS|Chrome)\/(\d+)/],
    ["Safari", /Version\/(\d+)(?:\.\d+)*.*Safari/],
  ];
  let browser = "";
  for (const [name, re] of browsers) {
    if ((v = m(re))) {
      browser = `${name} ${v[1]}`;
      break;
    }
  }
  const screen = width && height ? `${Math.round(width)}×${Math.round(height)}` : "";
  return [browser, os, screen].filter(Boolean).join(" · ").slice(0, 200);
}

const STOP = new Set([
  "the", "and", "for", "not", "with", "when", "does", "doesn", "can", "can't", "cant", "this", "that", "game", "please", "add",
  "der", "die", "das", "und", "nicht", "mit", "wenn", "ist", "ein", "eine", "kann", "geht", "spiel", "bitte",
]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

/** Earlier posts with a similar title, so people vote for those instead of posting the same thing again. */
export function similarPosts(title: string, posts: FeedbackPost[], limit = 3): FeedbackPost[] {
  const mine = words(title);
  if (!mine.size) return [];
  return posts
    .map((p) => ({ p, shared: [...words(p.title)].filter((w) => mine.has(w)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.p.vote_count - a.p.vote_count)
    .slice(0, limit)
    .map((x) => x.p);
}

/** "3 hours ago", "yesterday", or a date for anything older than a month. */
export function ago(iso: string, lang: "en" | "de", now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString(lang === "de" ? "de-CH" : "en", { dateStyle: "medium" });
}
