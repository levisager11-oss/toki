// Limits (ideas a day, messages an hour, ...) and deletion times, as this account has them.
// Admins set them on /admin/limits; the database checks them
// (supabase/migrations/20261130090000_admin_limits.sql). Texts show the numbers the admin set:
// "{limit.ideas_day}" in a text becomes the number, "{keep.chat_public|# day|# days}" picks the
// form for it (format() in i18n.tsx). No database client here, so the texts can use it.

/** Toki's values until an admin changes them; shown until the real ones are loaded. */
export const DEFAULT_LIMITS = {
  ideas_day: 3, ideas_month: 10, idea_replies_hour: 30,
  feedback_posts_hour: 5, feedback_posts_day: 20, feedback_replies_hour: 30,
  messages_20s: 8, messages_hour: 200, groups_day: 10, group_size: 20, reports_day: 30,
  friend_requests_day: 30, game_invites_10min: 30, party_size: 8,
  applications_month: 3,
  ai_translate: 120, ai_similar: 30, ai_suggest: 10, ai_help: 40, ai_release: 30, ai_describe: 30, ai_summary: 30, ai_learn: 10, ai_connect: 60, ai_moderate: 30,
  uploads_hour: 30, storage_mb: 1024,
} as const;
export const DEFAULT_KEEP = {
  chat_public: 7, chat_private: 30, notifications: 30, notifications_count: 100,
  reports_handled: 30, reports_all: 60, ideas: 180, translations: 30, suggestions: 7, connect_runs: 90,
} as const;

export type LimitKey = keyof typeof DEFAULT_LIMITS;
export type KeepKey = keyof typeof DEFAULT_KEEP;

/** The limits whose errors name them ("rate_limited:ideas_day"), each with its own text. */
export const RATE_ERRORS = [
  "ideas_day", "ideas_month", "idea_replies_hour", "feedback_posts_hour", "feedback_posts_day", "feedback_replies_hour",
  "messages_20s", "messages_hour", "groups_day", "reports_day", "friend_requests_day", "game_invites_10min", "applications_month",
] as const satisfies readonly LimitKey[];
export type LimitErrorKey = `limit.err.${(typeof RATE_ERRORS)[number]}`;

export type Values = { limits: Record<string, number | null>; keep: Record<string, number> };

let values: Values = { limits: { ...DEFAULT_LIMITS }, keep: { ...DEFAULT_KEEP } };
let version = 0;
const listeners = new Set<() => void>();

/** Takes this account's values as the database gave them (see loadLimits in limits.ts). */
export function setLimitValues(d: Values): void {
  values = { limits: { ...DEFAULT_LIMITS, ...d.limits }, keep: { ...DEFAULT_KEEP, ...d.keep } };
  version++;
  for (const l of listeners) l();
}

export function subscribeLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const limitsVersion = () => version;

/** This account's limit, or null when it has none (admins). */
export function limitOf(key: LimitKey): number | null {
  const v = values.limits[key];
  return v === undefined ? DEFAULT_LIMITS[key] : v;
}
/** A limit for showing or counting: admins see the players' value. */
export function limitShown(key: string): number | undefined {
  const v = values.limits[key];
  if (typeof v === "number") return v;
  return key in DEFAULT_LIMITS ? DEFAULT_LIMITS[key as LimitKey] : undefined;
}
export function keepOf(key: string): number | undefined {
  return values.keep[key] ?? (key in DEFAULT_KEEP ? DEFAULT_KEEP[key as KeepKey] : undefined);
}

/** The text for a limit the database named in its error, or null. */
export function limitErrorKey(message: string | undefined | null): LimitErrorKey | null {
  const m = /rate_limited:([a-z0-9_]+)/.exec(message ?? "");
  const key = m?.[1] as (typeof RATE_ERRORS)[number] | undefined;
  return key && (RATE_ERRORS as readonly string[]).includes(key) ? `limit.err.${key}` : null;
}

/**
 * Fills in {limit.key} and {keep.key} with the numbers. With forms ("{keep.ideas|# day|# days}")
 * the first is for 1 and the second for any other number, # being the number.
 */
export function fillLimits(text: string): string {
  if (!text.includes("{limit.") && !text.includes("{keep.")) return text;
  return text.replace(/\{(limit|keep)\.([a-z0-9_]+)(?:\|([^|}]*)\|([^}]*))?\}/g, (all, kind: string, key: string, one?: string, many?: string) => {
    const n = kind === "limit" ? limitShown(key) : keepOf(key);
    if (n === undefined) return all;
    if (one === undefined || many === undefined) return String(n);
    return (n === 1 ? one : many).split("#").join(String(n));
  });
}

