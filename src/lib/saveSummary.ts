// What the AI helper ("Ask AI") gets to see of a player's save: the game's storage as short text.
// Saves can be up to 1 MB (whole maps, pictures); the helper needs the small facts (level, items,
// quests). So long lists and texts are shortened, and things that look like logins are left out.

/** The most the helper reads of one save. */
export const MAX_SAVE_SUMMARY = 6000;
const MAX_KEYS = 80;
const HIDDEN = "[hidden]";

interface Limits {
  text: number;
  items: number;
  fields: number;
  depth: number;
}
/** Tried in order until the save fits. */
const LEVELS: Limits[] = [
  { text: 200, items: 30, fields: 60, depth: 6 },
  { text: 80, items: 10, fields: 30, depth: 4 },
  { text: 40, items: 4, fields: 12, depth: 3 },
];

const PASSWORD = /passwor[dt]|passwd|pwd|passcode/i;
// "tokens" may be coins and a "session" a round, so these only count for long values without spaces.
const SECRET = /secret|token|auth(?!or)|session|jwt|api[-_]?key|credential|cookie|signature/i;
const JWT = /^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*$/;
const EMAIL = /[^\s@]{1,64}@[^\s@]{1,200}\.[a-z]{2,}/gi;

const looksSecret = (name: string, v: unknown) =>
  PASSWORD.test(name) ? typeof v === "string" || typeof v === "number" : SECRET.test(name) && typeof v === "string" && v.length >= 12 && !/\s/.test(v);

function shrink(v: unknown, l: Limits, depth: number): unknown {
  if (typeof v === "string") {
    if (JWT.test(v)) return HIDDEN;
    // Games often keep JSON inside a text.
    if (/^\s*[[{]/.test(v) && v.length <= 1_000_000) {
      try {
        return shrink(JSON.parse(v), l, depth);
      } catch {
        /* just a text */
      }
    }
    // Long and without spaces: a picture or packed data, nothing to read.
    if (v.length > l.text && !/\s/.test(v.slice(0, 200))) return `[${v.length} characters]`;
    return (v.length > l.text ? `${v.slice(0, l.text)}…` : v).replace(EMAIL, HIDDEN);
  }
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    if (depth >= l.depth) return `[${v.length} items]`;
    const out = v.slice(0, l.items).map((x) => shrink(x, l, depth + 1));
    if (v.length > l.items) out.push(`… ${v.length - l.items} more`);
    return out;
  }
  const entries = Object.entries(v);
  if (depth >= l.depth) return `{${entries.length} fields}`;
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries.slice(0, l.fields)) out[k.slice(0, 60)] = looksSecret(k, x) ? HIDDEN : shrink(x, l, depth + 1);
  if (entries.length > l.fields) out["…"] = `${entries.length - l.fields} more fields`;
  return out;
}

function lines(keys: [string, string][], l: Limits): string[] {
  return keys.map(([k, raw]) => {
    const v = looksSecret(k, raw) ? HIDDEN : shrink(raw, l, 0);
    return `${k.slice(0, 60)}: ${typeof v === "string" ? v : JSON.stringify(v)}`.replace(/[\r\n]+/g, " ");
  });
}

/** Cuts lines so all fit in max characters: short lines stay whole, long ones share what is left. */
function fit(all: string[], max: number): string[] {
  const out = [...all];
  const order = out.map((_, i) => i).sort((a, b) => out[a].length - out[b].length);
  let left = max;
  order.forEach((i, n) => {
    const share = Math.floor(left / (order.length - n)) - 1;
    if (out[i].length > share) out[i] = `${out[i].slice(0, Math.max(0, share - 1))}…`;
    left -= out[i].length + 1;
  });
  return out;
}

/** A save's keys as text for the helper, one line per key, at most max characters. "" when empty. */
export function saveSummary(keys: Record<string, string>, max = MAX_SAVE_SUMMARY): string {
  const all = Object.entries(keys).filter(([, v]) => typeof v === "string");
  if (!all.length) return "";
  const shown = all.slice(0, MAX_KEYS);
  const more = all.length > shown.length ? `… ${all.length - shown.length} more keys` : "";
  const room = max - (more ? more.length + 1 : 0);
  let out: string[] = [];
  for (const l of LEVELS) {
    out = lines(shown, l);
    if (out.join("\n").length <= room) break;
  }
  if (out.join("\n").length > room) out = fit(out, room);
  return (more ? [...out, more] : out).join("\n").slice(0, max);
}
