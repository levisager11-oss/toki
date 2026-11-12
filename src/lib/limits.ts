// Loading the limits and deletion times, and changing them (admins). The values themselves and
// the texts' part are in limitValues.ts.
import { supabase } from "./supabase";
import { setLimitValues, type KeepKey, type LimitKey, type Values } from "./limitValues";

export * from "./limitValues";

/** Loads this account's values (after logging in or out, or a role change). */
export async function loadLimits(): Promise<void> {
  const { data, error } = await supabase.rpc("my_limits");
  if (error || !data) return; // the defaults stay
  setLimitValues(data as Values);
}

// ---------- admins ----------

export interface LimitRow {
  key: LimitKey;
  who: "both" | "player" | "creator" | "everyone";
  player: number;
  creator: number;
  min_value: number;
  max_value: number;
  /** Groups of ten: 10–19 ideas, 20–29 feedback, 30–39 chat, ... */
  sort: number;
}
export interface KeepRow {
  key: KeepKey;
  value: number;
  unit: "days" | "count";
  min_value: number;
  max_value: number;
}
export interface LimitOverride {
  user_id: string;
  username: string;
  role: string;
  key: LimitKey;
  value: number;
}
export interface AdminLimits {
  limits: LimitRow[];
  keep: KeepRow[];
  overrides: LimitOverride[];
}

export async function adminLimits(): Promise<AdminLimits> {
  const { data, error } = await supabase.rpc("admin_limits");
  if (error) throw error;
  return data as AdminLimits;
}

export async function setLimit(key: LimitKey, player: number, creator: number): Promise<void> {
  const { error } = await supabase.rpc("admin_set_limit", { p_key: key, p_player: player, p_creator: creator });
  if (error) throw error;
  await loadLimits();
}

/** null removes the account's own value. */
export async function setLimitOverride(userId: string, key: LimitKey, value: number | null): Promise<void> {
  const { error } = await supabase.rpc("admin_set_limit_override", { p_user: userId, p_key: key, p_value: value });
  if (error) throw error;
}

export async function setKeepTime(key: KeepKey, value: number): Promise<void> {
  const { error } = await supabase.rpc("admin_set_keep_time", { p_key: key, p_value: value });
  if (error) throw error;
  await loadLimits();
}

/** An account by username, for giving it its own value. */
export async function findAccount(username: string): Promise<{ id: string; username: string; role: string } | null> {
  const name = username.trim().replace(/^@/, "");
  if (!name) return null;
  const { data } = await supabase.from("profiles").select("id, username, role").ilike("username", name.replace(/[%_\\]/g, "\\$&")).limit(1).maybeSingle();
  return (data as { id: string; username: string; role: string } | null) ?? null;
}
