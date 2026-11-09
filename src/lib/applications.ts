// Developer accounts by application: players apply, admins approve (the account becomes a
// creator) or decline. Rules: supabase/migrations/20261109200000_developer_applications.sql
import { supabase } from "./supabase";

export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface Application {
  id: string;
  user_id: string;
  about: string;
  links: string;
  status: ApplicationStatus;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  applicant?: { username: string } | null;
}

export const APPLY_LIMITS = { aboutMin: 20, about: 2000, links: 1000 } as const;

/** An i18n key for what went wrong. */
export function applyErrorKey(error: { message?: string; code?: string } | null | undefined) {
  const m = error?.message ?? "";
  if (error?.code === "23505") return "apply.err.open" as const;
  if (m.includes("rate_limited")) return "apply.err.limit" as const;
  if (m.includes("already_developer")) return "apply.err.developer" as const;
  if (error?.code === "23514") return "apply.err.short" as const;
  return "error" as const;
}

export class ApplyError extends Error {
  constructor(readonly key: ReturnType<typeof applyErrorKey>) {
    super(key);
  }
}

/** The account's newest application, or null. */
export async function myApplication(): Promise<Application | null> {
  const { data, error } = await supabase.from("developer_applications").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ApplyError("error");
  return data as Application | null;
}

export async function apply(about: string, links: string): Promise<Application> {
  const { data, error } = await supabase.from("developer_applications").insert({ about: about.trim(), links: links.trim() }).select("*").single();
  if (error) throw new ApplyError(applyErrorKey(error));
  return data as Application;
}

export async function withdraw(id: string): Promise<void> {
  const { error } = await supabase.from("developer_applications").delete().eq("id", id);
  if (error) throw new ApplyError("error");
}

// ---------- admins ----------

const WITH_APPLICANT = "*, applicant:profiles!developer_applications_user_id_fkey(username)";

/** Open applications, oldest first. */
export async function openApplications(): Promise<Application[]> {
  const { data, error } = await supabase.from("developer_applications").select(WITH_APPLICANT).eq("status", "pending").order("created_at");
  if (error) throw error;
  return data as Application[];
}

export async function openApplicationCount(): Promise<number> {
  const { count, error } = await supabase.from("developer_applications").select("id", { count: "exact", head: true }).eq("status", "pending");
  return error ? 0 : count ?? 0;
}

export async function reviewApplication(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc("review_application", { p_id: id, p_approve: approve, p_note: note.trim() || null });
  if (error) throw error;
}

export async function developers(): Promise<{ id: string; username: string }[]> {
  const { data, error } = await supabase.from("profiles").select("id, username").eq("role", "creator").order("username");
  if (error) throw error;
  return data as { id: string; username: string }[];
}

export async function setDeveloper(userId: string, on: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_developer", { p_user: userId, p_developer: on });
  if (error) throw error;
}

/** Tells the menu's counter that the number of open applications changed. */
export const APPLICATIONS_CHANGED = "toki:applications-changed";

export type TextPart = { text: string; href?: string };

/** Splits text into plain parts and https links, so links in applications can be clicked. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /https:\/\/[^\s<>"]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""); // leave sentence punctuation out of the link
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
