// Achievements: what a game's list may hold, and how unlocks made without an account are kept in
// the browser. No imports, so the server (toki.json, Toki Connect) uses it too. The database has
// the same rules: supabase/migrations/20261128090000_achievements.sql.

export const MAX_ACHIEVEMENTS = 30;
/** What a game calls toki.achievement() with: letters, digits, "_", "-" and ".", at most 32. */
export const ACHIEVEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 120;
export const ICON_MAX = 16;
export const DEFAULT_ICON = "🏆";

export interface Achievement {
  id: string;
  name: string;
  name_de: string | null;
  description: string;
  description_de: string | null;
  /** An emoji. */
  icon: string;
}

/** Cut to at most n characters (as the database counts them), never in the middle of an emoji. */
export const cut = (s: string, n: number) => [...s].slice(0, n).join("");
const clean = (v: unknown, max: number) => (typeof v === "string" ? cut(v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(), max) : "");

/** Whether it can be an icon: an emoji (or a few), no spaces, at most 16 characters. */
export const isIcon = (s: string) => !!s && !/\s/.test(s) && [...s].length <= ICON_MAX && /[^\x00-\x7f]/.test(s);

/** An icon as the database takes it; else the trophy. */
export function cleanIcon(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return isIcon(s) ? s : DEFAULT_ICON;
}

/**
 * A list of achievements (from toki.json, or proposed by Toki Connect), checked: entries without
 * a usable id or name and repeated ids are left out, long texts are cut, at most 30.
 */
export function readAchievements(raw: unknown): Achievement[] {
  if (!Array.isArray(raw)) return [];
  const out: Achievement[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length >= MAX_ACHIEVEMENTS) break;
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const name = clean(o.name, NAME_MAX);
    if (!ACHIEVEMENT_ID.test(id) || seen.has(id) || !name) continue;
    seen.add(id);
    out.push({
      id,
      name,
      name_de: clean(o.name_de, NAME_MAX) || null,
      description: clean(o.description, DESCRIPTION_MAX),
      description_de: clean(o.description_de, DESCRIPTION_MAX) || null,
      icon: cleanIcon(o.icon),
    });
  }
  return out;
}

/** What's wrong with a list the developer typed in the form, as an i18n key; null when it can be saved. */
export function achievementProblem(list: Achievement[]): "ach.err.tooMany" | "ach.err.id" | "ach.err.sameId" | "ach.err.name" | "ach.err.icon" | null {
  if (list.length > MAX_ACHIEVEMENTS) return "ach.err.tooMany";
  const seen = new Set<string>();
  for (const a of list) {
    if (!ACHIEVEMENT_ID.test(a.id)) return "ach.err.id";
    if (seen.has(a.id)) return "ach.err.sameId";
    seen.add(a.id);
    if (!a.name.trim()) return "ach.err.name";
    const icon = a.icon.trim();
    if (icon && !isIcon(icon)) return "ach.err.icon";
  }
  return null;
}

/** An id made from a name ("First win!" → "first-win"), not one of the taken ones. */
export function idFromName(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "") || "achievement";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The name and description in the player's language (German falls back to English). */
export function achievementText(a: Pick<Achievement, "name" | "name_de" | "description" | "description_de">, lang: "en" | "de") {
  return {
    name: (lang === "de" && a.name_de) || a.name,
    description: (lang === "de" && a.description_de) || a.description,
  };
}

// ---------- unlocks without an account ----------

/** Unlocked in this browser before logging in; moved to the account at login (claim_achievements). */
export interface GuestUnlock {
  game: string;
  id: string;
  /** milliseconds since 1970 */
  at: number;
}

export const MAX_GUEST_UNLOCKS = 300;

export function readGuestUnlocks(raw: unknown): GuestUnlock[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((u): u is GuestUnlock => !!u && typeof u.game === "string" && typeof u.id === "string" && ACHIEVEMENT_ID.test(u.id) && Number.isFinite(u.at))
    .map((u) => ({ game: u.game, id: u.id, at: u.at }))
    .slice(0, MAX_GUEST_UNLOCKS);
}

/** Adds an unlock (newest first); added: false when it was there already or the list is full. */
export function addGuestUnlock(list: GuestUnlock[], game: string, id: string, at: number): { list: GuestUnlock[]; added: boolean } {
  if (list.some((u) => u.game === game && u.id === id) || list.length >= MAX_GUEST_UNLOCKS) return { list, added: false };
  return { list: [{ game, id, at }, ...list], added: true };
}

/** What the game sent with toki.achievement(id), if it can be an achievement's id. */
export const sentId = (v: unknown): string | null => (typeof v === "string" && ACHIEVEMENT_ID.test(v) ? v : null);
