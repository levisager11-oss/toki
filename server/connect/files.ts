// Toki Connect: which files of a repository the AI reads, how its changes are applied, and how its
// answers are read. No network here, so all of it is easy to test.
import type { TreeEntry } from "../github.js";

/** A file the AI may read at most (characters), and all files together. */
export const MAX_FILE = 60_000;
export const MAX_TOTAL = 150_000;
/** Most files one pull request may change, and the largest file it may write. */
export const MAX_CHANGED = 20;
export const MAX_WRITE = 200_000;

const TEXT = /\.(html?|js|mjs|cjs|jsx|ts|tsx|gd|cs|json|cfg|godot|tscn|lua|hx|vue|svelte|css|md|txt)$/i;
const SKIP = /(^|\/)(node_modules|\.git|\.godot|\.import|dist|build|out|vendor|Library|Temp|obj|bin|coverage|\.next|\.cache)(\/|$)|\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

/** Files worth showing the AI: code and config, not built output, dependencies or lock files. */
export const readable = (e: Pick<TreeEntry, "path" | "type" | "size">) =>
  e.type === "blob" && TEXT.test(e.path) && !SKIP.test(e.path) && (e.size ?? 0) <= MAX_FILE;

/** How likely a file matters for adding saves or scores (higher first). */
function score(path: string): number {
  const p = path.toLowerCase();
  const name = p.split("/").pop() ?? p;
  let s = 0;
  if (name === "index.html") s += 100;
  else if (name.endsWith(".html")) s += 40;
  if (name === "project.godot" || name === "export_presets.cfg") s += 90;
  if (name === "package.json") s += 30;
  if (/save|storage|persist|score|highscore|leaderboard|game_?over|gameover|round|level|main|game/.test(name)) s += 50;
  if (/\.(js|mjs|ts|tsx|jsx|gd|cs|lua|hx)$/.test(name)) s += 10;
  if (/^(src|scripts|js|game)\//.test(p)) s += 5;
  s -= p.split("/").length; // shallower first
  return s;
}

/** The files read first, up to MAX_TOTAL characters (sizes from the tree). */
export function pickFiles(tree: TreeEntry[]): string[] {
  const picked: string[] = [];
  let total = 0;
  for (const e of tree.filter(readable).sort((a, b) => score(b.path) - score(a.path) || (a.size ?? 0) - (b.size ?? 0))) {
    const size = e.size ?? 0;
    if (total + size > MAX_TOTAL) continue;
    picked.push(e.path);
    total += size;
    if (picked.length >= 40) break;
  }
  return picked;
}

/** A path the AI may write: inside the repository, not GitHub settings or workflows. */
export function safePath(p: string): boolean {
  if (!p || p.length > 300 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return false;
  return !/^\.github(\/|$)/i.test(p) && !/^\.git(\/|$)/i.test(p);
}

export type Edit =
  | { path: string; search: string; replace: string }
  | { path: string; content: string };

/**
 * Applies the AI's changes to the files it read. A "search" must appear exactly once in the file
 * (as it is after the earlier edits), so a change never lands in the wrong place. Returns the
 * changed files, or what went wrong.
 */
export function applyEdits(files: Record<string, string>, edits: unknown): { changed: Record<string, string>; errors: string[] } {
  const errors: string[] = [];
  const changed: Record<string, string> = {};
  if (!Array.isArray(edits) || edits.length === 0) return { changed, errors: ["no edits"] };
  for (const raw of edits as Record<string, unknown>[]) {
    const path = typeof raw?.path === "string" ? raw.path : "";
    if (!safePath(path)) {
      errors.push(`not allowed to write "${path}"`);
      continue;
    }
    if (typeof raw.content === "string") {
      changed[path] = raw.content;
      continue;
    }
    if (typeof raw.search !== "string" || typeof raw.replace !== "string" || !raw.search) {
      errors.push(`${path}: an edit needs "search" and "replace", or "content"`);
      continue;
    }
    const current = changed[path] ?? files[path];
    if (current === undefined) {
      errors.push(`${path}: read the file before changing it, or give its full "content"`);
      continue;
    }
    const at = current.indexOf(raw.search);
    if (at < 0) {
      errors.push(`${path}: "search" text not found (copy it exactly from the file)`);
      continue;
    }
    if (current.indexOf(raw.search, at + 1) >= 0) {
      errors.push(`${path}: "search" text appears more than once (make it longer)`);
      continue;
    }
    changed[path] = current.slice(0, at) + raw.replace + current.slice(at + raw.search.length);
  }
  const paths = Object.keys(changed);
  if (paths.length > MAX_CHANGED) errors.push(`too many files changed (${paths.length}, at most ${MAX_CHANGED})`);
  for (const p of paths) if (changed[p].length > MAX_WRITE) errors.push(`${p}: too large`);
  for (const p of paths) if (changed[p] === files[p]) delete changed[p];
  if (!errors.length && !Object.keys(changed).length) errors.push("the edits change nothing");
  return { changed: errors.length ? {} : changed, errors };
}

/** Reads the one JSON object the AI answers with, also inside a ``` block or with text around it. */
export function parseAiJson(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  const value = JSON.parse(body.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the answer isn't a JSON object");
  return value as Record<string, unknown>;
}
