// What the law asks for: the age question, deleting an account, a copy of your data, and reports
// about games, profiles, feedback posts and ideas (supabase/migrations/20261201090000_legal.sql).
import { supabase } from "./supabase";
import { removeAvatarFile, socialErrorKey, SocialError, type Person } from "./social";
import { removeGameImages } from "./gameImages";

/** Accounts are for players of this age and older. */
export const MIN_AGE = 13;
/** Younger than this, a parent has to agree. */
export const PARENT_AGE = 16;

/** "2012-03" from the two fields, or null while one is empty. */
export function bornValue(year: string, month: string): string | null {
  if (!/^\d{4}$/.test(year) || !/^([1-9]|1[0-2])$/.test(month)) return null;
  return `${year}-${month.padStart(2, "0")}`;
}

/**
 * Full years of someone born in the month "YYYY-MM", counted as if the birthday were on the
 * month's last day (as the database does): never too old.
 */
export function ageOf(born: string, now = new Date()): number {
  const [y, m] = born.split("-").map(Number);
  // the first day of the month after the month of birth
  const from = new Date(y, m, 1);
  let age = now.getFullYear() - from.getFullYear();
  if (now.getMonth() < from.getMonth() || (now.getMonth() === from.getMonth() && now.getDate() < from.getDate())) age--;
  return age;
}

// A player who was too young for an account isn't asked again on this device for a week, so
// trying other months doesn't help.
const TOO_YOUNG_KEY = "toki.signup.wait";
const TOO_YOUNG_MS = 7 * 86_400_000;

export function tooYoungHere(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(TOO_YOUNG_KEY));
    return at > 0 && now - at < TOO_YOUNG_MS;
  } catch {
    return false;
  }
}

export function rememberTooYoung() {
  try {
    localStorage.setItem(TOO_YOUNG_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new SocialError(socialErrorKey(error));
  return data as T;
}

/** Whether this account still has to say when its player was born (accounts from before the question). */
export async function ageNeeded(): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_account");
  // An older database, or offline: don't ask.
  if (error || !data) return false;
  return (data as { age_needed?: boolean }).age_needed === true;
}

/** "too_young": the account is gone. */
export const setBirth = (born: string, parentOk: boolean) => rpc<"ok" | "too_young">("set_birth", { p_born: born, p_parent_ok: parentOk });

/** Everything Toki keeps about the logged-in account. */
export const exportMyData = () => rpc<Record<string, unknown>>("export_my_data");

/** Hands the browser a file to save. */
export function saveFile(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Deletes the logged-in account with everything in it. The pictures go first (the avatar and the
 * pictures of the account's games), since only their owner may delete those files.
 */
export async function deleteAccount(profile: { id: string; avatar_url?: string | null }) {
  const { data: games } = await supabase.from("games").select("thumbnail_url, banner_url, screenshots").eq("created_by", profile.id);
  const pictures = ((games ?? []) as { thumbnail_url: string | null; banner_url: string | null; screenshots: string[] | null }[])
    .flatMap((g) => [g.thumbnail_url, g.banner_url, ...(g.screenshots ?? [])]);
  const { error } = await supabase.rpc("delete_account");
  // The reason as the database gave it ("last_admin").
  if (error) throw new Error(error.message);
  // Only now: if deleting was refused, the account keeps its pictures.
  await Promise.all([removeGameImages(pictures), removeAvatarFile(profile.avatar_url ?? null).catch(() => {})]);
}

// ---------- reports ----------

export type ReportKind = "game" | "profile" | "feedback" | "idea";
export const REPORT_CATEGORIES = ["illegal", "copyright", "harassment", "sexual", "spam", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_REASON_MAX = 1000;
export const REPORT_NOTE_MAX = 500;

export const reportContent = (kind: ReportKind, target: string, category: ReportCategory, reason: string) =>
  rpc<void>("report_content", { p_kind: kind, p_target: target, p_category: category, p_reason: reason });

export interface ContentReport {
  id: number;
  kind: ReportKind;
  target: string;
  category: ReportCategory;
  reason: string;
  title: string;
  created_at: string;
  handled_at: string | null;
  outcome: "dismissed" | "removed" | "banned" | null;
  note: string | null;
  owner: Person | null;
  reporter: Person | null;
  /** the AI's first look, when an admin asked for it */
  ai_verdict?: "remove" | "keep" | "unsure" | null;
  ai_reason?: string | null;
}

/** Admins: reports about games, profiles, feedback posts and ideas. */
export async function listContentReports(open: boolean): Promise<ContentReport[]> {
  const person = "id, username, avatar_url, avatar_seed";
  let q = supabase
    .from("content_reports")
    .select(`*, owner:profiles!content_reports_owner_id_fkey(${person}), reporter:profiles!content_reports_reporter_id_fkey(${person})`);
  q = open ? q.is("handled_at", null).order("created_at") : q.not("handled_at", "is", null).order("handled_at", { ascending: false }).limit(100);
  const { data, error } = await q;
  if (error) throw new SocialError(socialErrorKey(error));
  return data as unknown as ContentReport[];
}

export const handleContentReport = (id: number, outcome: "dismissed" | "removed" | "banned", note: string, days = 0) =>
  rpc<void>("handle_content_report", { p_report: id, p_outcome: outcome, p_note: note, p_days: days });
