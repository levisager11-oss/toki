// Profiles, friends, chat, notifications and high scores. The rules (who sees and may do what)
// live in the database: supabase/migrations/20261110100000_profiles.sql and the ones after it.
import { supabase } from "./supabase";
import type { Role } from "./types";
import { limitErrorKey, type LimitErrorKey } from "./limitValues";

/** An i18n key for what went wrong, from the server's error. */
export type SocialErrorKey =
  | "soc.err.banned" | "soc.err.blocked" | "soc.err.notFriends" | "soc.err.rateLimited"
  | "soc.err.groupFull" | "soc.err.login" | "soc.err.badCode" | "soc.err.partyFull" | LimitErrorKey | "error";

export class SocialError extends Error {
  constructor(readonly key: SocialErrorKey) {
    super(key);
  }
}

export function socialErrorKey(error: { message?: string } | null | undefined): SocialErrorKey {
  const m = error?.message ?? "";
  if (m.includes("banned")) return "soc.err.banned";
  if (m.includes("blocked")) return "soc.err.blocked";
  if (m.includes("not_friends") || m.includes("not_member")) return "soc.err.notFriends";
  if (m.includes("rate_limited")) return limitErrorKey(m) ?? "soc.err.rateLimited";
  if (m.includes("group_full")) return "soc.err.groupFull";
  if (m.includes("party_full")) return "soc.err.partyFull";
  if (m.includes("login_required")) return "soc.err.login";
  if (m.includes("bad_code")) return "soc.err.badCode";
  return "error";
}
const fail = (error: { message?: string }) => new SocialError(socialErrorKey(error));

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw fail(error);
  return data as T;
}

// ---------- profiles ----------

export const LIMITS = { bio: 200, message: 500, groupTitle: 40, reason: 200 } as const;
/** Online means Toki was open in the last 5 minutes (it checks in every 2 minutes). */
export const ONLINE_MS = 5 * 60_000;

export interface Person {
  id: string;
  username: string;
  avatar_url: string | null;
  avatar_seed: string | null;
  role?: Role;
}

export type Relation = "self" | "guest" | "friend" | "sent" | "received" | "blocked" | "none";

export interface ProfilePage extends Person {
  role: Role;
  bio: string;
  created_at: string;
  relation: Relation;
  friend_count: number;
  /** liked games, newest first */
  likes: string[];
  /** Playtime (seconds), games played, high scores and favorites. Missing before the playtime update. */
  stats?: { seconds: number; games: number; scores: number; likes: number };
  banned_until?: string | null;
  // Only for the player themself and their friends:
  last_seen?: string | null;
  playing?: string | null;
  recent?: string[];
  /** Up to 6 games with the most playtime, most first. */
  most_played?: { game_id: string; seconds: number }[];
}

export const getProfile = (username: string) => rpc<ProfilePage | null>("get_profile", { p_username: username });

export async function updateProfile(id: string, change: { bio?: string; avatar_url?: string | null; avatar_seed?: string | null }) {
  const { error } = await supabase.from("profiles").update(change).eq("id", id);
  if (error) throw fail(error);
}

/** Uploads an avatar (already made small, see shrinkImage) and returns its public link. */
export async function uploadAvatar(userId: string, blob: Blob): Promise<string> {
  const path = `${userId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage.from("avatars").upload(path, blob, { contentType: blob.type || "image/webp", upsert: false });
  if (error) throw fail(error);
  return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}

/** Deletes an earlier avatar of this account (only its own files can be deleted). */
export async function removeAvatarFile(url: string | null) {
  const marker = "/storage/v1/object/public/avatars/";
  const i = url?.indexOf(marker) ?? -1;
  if (!url || i < 0) return;
  await supabase.storage.from("avatars").remove([url.slice(i + marker.length)]);
}

export const isOnline = (lastSeen: string | null | undefined, now = Date.now()) =>
  !!lastSeen && now - new Date(lastSeen).getTime() < ONLINE_MS;

// ---------- friends ----------

export interface FriendRow extends Person {
  user_id: string;
  status: "friend" | "sent" | "received";
  last_seen: string | null;
  playing: string | null;
}

export async function myFriends(): Promise<FriendRow[]> {
  const rows = await rpc<FriendRow[]>("my_friends");
  return rows.map((r) => ({ ...r, id: r.user_id }));
}
export const sendFriendRequest = (userId: string) => rpc<"sent" | "friends" | "already">("send_friend_request", { p_user: userId });
export const answerFriendRequest = (from: string, accept: boolean) => rpc<void>("answer_friend_request", { p_from: from, p_accept: accept });
export const removeFriend = (userId: string) => rpc<void>("remove_friend", { p_user: userId });
export const blockUser = (userId: string) => rpc<void>("block_user", { p_user: userId });
export const unblockUser = (userId: string) => rpc<void>("unblock_user", { p_user: userId });

export async function myBlocks(): Promise<Person[]> {
  const { data, error } = await supabase
    .from("blocks")
    .select("blocked:profiles!blocks_blocked_id_fkey(id, username, avatar_url, avatar_seed)")
    .order("created_at", { ascending: false });
  if (error) throw fail(error);
  return (data as unknown as { blocked: Person }[]).map((r) => r.blocked);
}

/** Players whose name starts with this text, for adding friends. */
export async function findPlayers(q: string): Promise<Person[]> {
  const name = q.trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_]/g, "");
  if (name.length < 2) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, avatar_url, avatar_seed, role")
    .like("username", `${name}%`)
    .order("username")
    .limit(10);
  if (error) throw fail(error);
  return data as Person[];
}

// ---------- chat ----------

/** "party": the chat of a party (src/lib/party.ts), which goes with it. */
export type ChatKind = "public" | "game" | "dm" | "group" | "party";

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string | null;
  game_id: string | null;
  last_message_at: string | null;
  last_body: string | null;
  last_author: string | null;
  unread: number;
  members: number;
  other_id: string | null;
  other_username: string | null;
  other_avatar_url: string | null;
  other_avatar_seed: string | null;
}

export interface Chat {
  id: string;
  kind: ChatKind;
  title: string | null;
  game_id: string | null;
}

export interface Message {
  id: number;
  chat_id: string;
  author_id: string;
  body: string;
  created_at: string;
  author?: Person | null;
}

export const MESSAGE_PAGE = 50;
const MESSAGE = "id, chat_id, author_id, body, created_at, author:profiles!messages_author_id_fkey(id, username, avatar_url, avatar_seed, role)";

export const myChats = () => rpc<ChatSummary[]>("my_chats");
/** The public Toki room (gameId null) or a game's room. */
export const roomId = (gameId: string | null) => rpc<string>("room", { p_game: gameId });
export const openDm = (userId: string) => rpc<string>("open_dm", { p_user: userId });
export const createGroup = (title: string, members: string[]) => rpc<string>("create_group", { p_title: title, p_members: members });
export const addToGroup = (chatId: string, userId: string) => rpc<void>("add_to_group", { p_chat: chatId, p_user: userId });
export const renameGroup = (chatId: string, title: string) => rpc<void>("rename_group", { p_chat: chatId, p_title: title });
export const leaveGroup = (chatId: string) => rpc<void>("leave_group", { p_chat: chatId });
export const markChatRead = (chatId: string) => rpc<void>("mark_chat_read", { p_chat: chatId });
export const reportMessage = (id: number, reason: string) => rpc<void>("report_message", { p_message: id, p_reason: reason });

export async function getChat(id: string): Promise<Chat | null> {
  const { data, error } = await supabase.from("chats").select("id, kind, title, game_id").eq("id", id).maybeSingle();
  if (error) throw fail(error);
  return data as Chat | null;
}

export async function chatMembers(chatId: string): Promise<Person[]> {
  const { data, error } = await supabase
    .from("chat_members")
    .select("member:profiles!chat_members_user_id_fkey(id, username, avatar_url, avatar_seed, role)")
    .eq("chat_id", chatId);
  if (error) throw fail(error);
  return (data as unknown as { member: Person }[]).map((r) => r.member);
}

/** The newest messages (oldest first), or those before message `before`. */
export async function listMessages(chatId: string, before?: number): Promise<Message[]> {
  let q = supabase.from("messages").select(MESSAGE).eq("chat_id", chatId);
  if (before) q = q.lt("id", before);
  const { data, error } = await q.order("id", { ascending: false }).limit(MESSAGE_PAGE);
  if (error) throw fail(error);
  return (data as unknown as Message[]).reverse();
}

export async function getMessage(id: number): Promise<Message | null> {
  const { data, error } = await supabase.from("messages").select(MESSAGE).eq("id", id).maybeSingle();
  if (error) return null;
  return data as unknown as Message | null;
}

export async function sendMessage(chatId: string, body: string): Promise<Message> {
  const { data, error } = await supabase.from("messages").insert({ chat_id: chatId, body }).select(MESSAGE).single();
  if (error) throw fail(error);
  return data as unknown as Message;
}

export async function deleteMessage(id: number) {
  const { error } = await supabase.from("messages").delete().eq("id", id);
  if (error) throw fail(error);
}

// ---------- reports (admins) ----------

export interface Report {
  id: number;
  message_id: number | null;
  chat_id: string | null;
  body: string;
  reason: string;
  created_at: string;
  handled_at: string | null;
  outcome: "dismissed" | "deleted" | "banned" | null;
  author: Person | null;
  reporter: Person | null;
}

export async function listReports(open: boolean): Promise<Report[]> {
  let q = supabase
    .from("message_reports")
    .select("*, author:profiles!message_reports_author_id_fkey(id, username, avatar_url, avatar_seed), reporter:profiles!message_reports_reporter_id_fkey(id, username, avatar_url, avatar_seed)");
  q = open ? q.is("handled_at", null) : q.not("handled_at", "is", null);
  const { data, error } = await q.order("created_at", { ascending: !open }).limit(100);
  if (error) throw fail(error);
  return data as unknown as Report[];
}
export const handleReport = (id: number, outcome: "dismissed" | "deleted" | "banned", days = 0) =>
  rpc<void>("handle_report", { p_report: id, p_outcome: outcome, p_days: days });

// ---------- notifications ----------

export type NotificationKind =
  | "fb_reply" | "fb_status" | "friend_request" | "friend_accept" | "group_add" | "score_beaten"
  /** a friend invites you into their room in a multiplayer game */
  | "game_invite"
  /** Toki can do something new for developers' games */
  | "dev_news"
  /** a game idea: proposed (to developers), a reply, claimed, given back or done */
  | "game_idea"
  /** an admin removed something of yours (with the reason), or handled something you reported */
  | "moderation" | "report_done"
  /** a question from an admin on your developer application (to you), or the applicant's answer (to admins) */
  | "application";

export interface Notification {
  id: number;
  kind: NotificationKind;
  data: {
    post?: string; title?: string; status?: string; version?: string | null; chat?: string; game?: string; official?: boolean;
    /** game_invite: the room's code, and the party of whoever invited */
    code?: string;
    party?: string;
    /** dev_news: what is new, e.g. "multiplayer" */
    topic?: string;
    /** score_beaten on one of a game's other boards: its id and name */
    board?: string;
    board_name?: string;
    board_name_de?: string | null;
    /** game_idea: the idea, and what happened to it */
    idea?: string;
    event?: "new" | "reply" | "claimed" | "released" | "done" | "question" | "answer";
    /** application: which developer application */
    application?: string;
    /** moderation, report_done: what it was about, the admin's reason, days banned, and what the admin did */
    what?: "game" | "profile" | "feedback" | "idea" | "message";
    note?: string;
    days?: number | null;
    outcome?: "dismissed" | "removed" | "banned";
  };
  created_at: string;
  read_at: string | null;
  actor: Person | null;
}

export async function listNotifications(): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, data, created_at, read_at, actor:profiles!notifications_actor_id_fkey(id, username, avatar_url, avatar_seed)")
    .order("id", { ascending: false })
    .limit(100);
  if (error) throw fail(error);
  return data as unknown as Notification[];
}

/**
 * Invites a friend into the room with this code in a multiplayer game. They see it in the bell,
 * and as a pop-up while they are on Toki. A new invite replaces an earlier one to that friend.
 */
export const inviteToGame = (userId: string, gameId: string, code: string) =>
  rpc<void>("invite_to_game", { p_user: userId, p_game: gameId, p_code: code });

export const markNotificationsRead = (ids?: number[]) => rpc<void>("mark_notifications_read", { p_ids: ids ?? null });

export async function clearNotifications() {
  const { error } = await supabase.from("notifications").delete().not("id", "is", null);
  if (error) throw fail(error);
}

// ---------- high scores ----------

export type ScoreOrder = "high" | "low";
export type ScoreFormat = "points" | "time";

export interface ScoreRow extends Person {
  rank: number;
  user_id: string;
  score: number;
  achieved_at: string;
}

/** The top of a game's list: its main board (""), or another of its boards. */
export async function leaderboard(gameId: string, limit = 10, board = ""): Promise<ScoreRow[]> {
  const rows = await rpc<ScoreRow[]>("leaderboard", board ? { p_game: gameId, p_limit: limit, p_board: board } : { p_game: gameId, p_limit: limit });
  return rows.map((r) => ({ ...r, id: r.user_id, rank: Number(r.rank), score: Number(r.score) }));
}

export interface PlayerScore {
  game_id: string;
  score: number;
  rank: number;
  players: number;
  /** "" for the game's main board (servers before 20261129090000_boards.sql have only that one) */
  board: string;
  /** the board's name (for the main board: the name its developer gave it, if any) */
  board_name: string | null;
  board_name_de: string | null;
  /** how the board shows its scores (missing on older servers: the game's own) */
  score_format?: ScoreFormat;
  /** the game has more than its main board */
  has_boards: boolean;
}

export async function playerScores(userId: string): Promise<PlayerScore[]> {
  const rows = await rpc<Partial<PlayerScore>[]>("player_scores", { p_user: userId });
  return rows.map((r) => ({
    game_id: r.game_id!, score: Number(r.score), rank: Number(r.rank), players: Number(r.players),
    board: r.board ?? "", board_name: r.board_name ?? null, board_name_de: r.board_name_de ?? null, score_format: r.score_format, has_boards: !!r.has_boards,
  }));
}

/**
 * What a score changed. best / new: all time. week / day: the player's best this week and
 * today (day only on Today's game). bar: what a later score must beat to change anything.
 * Servers before 20261127090000_daily_and_weekly.sql only send best and new.
 */
export interface ScoreResult {
  best: number;
  new: boolean;
  week?: number;
  week_new?: boolean;
  day?: number | null;
  day_new?: boolean;
  daily?: boolean;
  bar?: number;
}

/**
 * Sends a score to the game's main board (""), or to another of its boards. null: the game has
 * no such board (the score is ignored).
 */
export const submitScore = (gameId: string, score: number, board = ""): Promise<ScoreResult | null> =>
  board
    ? rpc<ScoreResult | null>("submit_score", { p_game: gameId, p_score: Math.round(score), p_board: board })
    : rpc<ScoreResult>("submit_score", { p_game: gameId, p_score: Math.round(score) });

/** Removes a player's score from one board of a game (the main one: ""). */
export async function removeScore(gameId: string, userId: string, board = "") {
  const { error } = await supabase.from("game_scores").delete().eq("game_id", gameId).eq("user_id", userId).eq("board", board);
  if (error) throw fail(error);
}

/** A score as players read it: 12,345 points, or a time like 1:02.345. */
export function formatScore(score: number, format: ScoreFormat | undefined, lang: "en" | "de"): string {
  if (format === "time") {
    const neg = score < 0;
    const ms = Math.abs(Math.round(score));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const rest = String(ms % 1000).padStart(3, "0");
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return `${neg ? "-" : ""}${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}.${rest}`;
  }
  return Math.round(score).toLocaleString(lang === "de" ? "de-CH" : "en");
}

/** Whether a score sent by a game can be saved: a finite number in range. */
export const validScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
