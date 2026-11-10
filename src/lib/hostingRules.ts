// Rules for games hosted on Toki, shared by the website and the server: which files may be
// uploaded, how big a game may be, the game's address, and what a toki.json may say.
import { CATEGORIES, type Category } from "./types.js";

export const MAX_GAME_BYTES = 100 * 1024 * 1024;
export const MAX_GAME_FILES = 3000;
/** How long the version before the newest one is kept, to roll back. */
export const KEEP_PREVIOUS_DAYS = 30;

/** Names a game's address may not take: they are, or might become, Toki's own. */
export const RESERVED_SITES = new Set([
  "www", "api", "app", "admin", "mail", "email", "smtp", "imap", "pop", "ftp", "ns1", "ns2", "games", "game", "play",
  "status", "docs", "doc", "blog", "cdn", "assets", "static", "auth", "login", "toki", "dev", "staging", "preview",
  "test", "help", "support", "shop", "store", "news", "m", "dashboard", "connect", "upload", "files", "r2", "worker",
]);

// Files that come along in ZIPs and folders but never belong to the game.
const JUNK = /(^|\/)(__MACOSX|\.git|\.github|\.svn|node_modules|\.vscode|\.idea)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

/** A file's path inside the game, cleaned up; null when it is not allowed (or junk to skip). */
export function cleanPath(raw: string): string | null {
  const p = raw.normalize("NFC").replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!p || p.length > 300 || p.endsWith("/")) return null;
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === "..")) return null;
  if (JUNK.test(p)) return null;
  return p;
}

export interface PlannedFile {
  /** The path as the uploader sent it */
  from: string;
  /** The path inside the game */
  path: string;
  size: number;
}

export type PlanError = "no_files" | "too_many_files" | "too_big" | "bad_file" | "no_entry";

/**
 * Which files go up and under which names. A ZIP of a folder (everything inside one folder and no
 * index.html outside it) loses that folder, so the game's index.html is at the top.
 */
export function planFiles(files: { path: string; size: number }[], entryWanted?: string | null): { files: PlannedFile[]; entry: string; bytes: number } | { error: PlanError } {
  const kept: PlannedFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== "string" || !Number.isSafeInteger(f.size) || f.size < 0) return { error: "bad_file" };
    const path = cleanPath(f.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    kept.push({ from: f.path, path, size: f.size });
  }
  if (!kept.length) return { error: "no_files" };
  // One folder around everything: drop it.
  for (;;) {
    const first = kept[0].path.split("/")[0];
    const nested = kept.every((f) => f.path.startsWith(`${first}/`));
    if (!nested || (entryWanted && kept.some((f) => f.path === entryWanted))) break;
    for (const f of kept) f.path = f.path.slice(first.length + 1);
  }
  if (kept.length > MAX_GAME_FILES) return { error: "too_many_files" };
  const bytes = kept.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_GAME_BYTES) return { error: "too_big" };
  const paths = new Set(kept.map((f) => f.path));
  let entry = entryWanted && cleanPath(entryWanted);
  if (entry && !paths.has(entry)) entry = null;
  if (!entry) entry = paths.has("index.html") ? "index.html" : null;
  if (!entry) {
    // No index.html: a single page at the top is the game (e.g. "My Game.html").
    const pages = kept.filter((f) => /\.html?$/i.test(f.path) && !f.path.includes("/"));
    if (pages.length === 1) entry = pages[0].path;
  }
  if (!entry) return { error: "no_entry" };
  return { files: kept, entry, bytes };
}

/** The game's address name, from its slug: never one of Toki's own names. */
export function siteFor(slug: string, attempt = 0): string {
  let base = slug.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "game";
  if (RESERVED_SITES.has(base)) base = `${base}-game`;
  if (attempt === 0) return base;
  const tag = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${base}-${tag}`;
}

/** The address a hosted game is played at. */
export function siteUrl(site: string, domain: string, entry = "index.html"): string {
  const path = entry === "index.html" ? "" : entry.split("/").map(encodeURIComponent).join("/");
  return `https://${site}.${domain}/${path}`;
}

export function isHostedUrl(url: string, domain: string | null | undefined): boolean {
  if (!domain) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(`.${domain}`) && !u.hostname.slice(0, -domain.length - 1).includes(".");
  } catch {
    return false;
  }
}

/** What a game may say about itself in a toki.json file next to its index.html. */
export interface TokiJson {
  title?: string;
  slug?: string;
  description?: string;
  description_de?: string;
  controls?: string;
  category?: Category;
  engine?: string;
  /** The page that starts the game, when it isn't index.html */
  entry?: string;
  /** Needs cross-origin isolation (Godot 4 with threads, some Unity builds) */
  isolation?: boolean;
  score_order?: "high" | "low";
  score_format?: "points" | "time";
  /** The game has multiplayer rooms friends can be invited into (see "Play together" in agents.md) */
  multiplayer?: boolean;
  /** How many can play together (2 to 64) */
  max_players?: number;
  /** The name of the room code in the game's invite links, when it isn't "room" */
  join_param?: string;
  /** Pictures inside the game's files (or https links): the cover, and up to 4 screenshots */
  cover_image?: string;
  screenshots?: string[];
  /** A new version number posts an update on the game's Updates page */
  version?: string;
  update_title?: string;
  notes?: string;
  /** Only for the upload script: the folder with the game, when it isn't the one with toki.json */
  folder?: string;
}

/** The name of the room code in a game's invite links (<game>?room=ABCD): short and plain. */
export const JOIN_PARAM = /^[a-z][a-z0-9_-]{0,19}$/;

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** A toki.json, checked: anything unknown or wrong is left out instead of failing the upload. */
export function readTokiJson(raw: unknown): TokiJson {
  let o: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) o = raw as Record<string, unknown>;
  const out: TokiJson = {};
  const title = text(o.title, 60);
  if (title) out.title = title;
  const slug = text(o.slug, 40)?.toLowerCase();
  if (slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) out.slug = slug;
  const description = text(o.description, 1000);
  if (description) out.description = description;
  const de = text(o.description_de, 1000);
  if (de) out.description_de = de;
  const controls = text(o.controls, 500);
  if (controls) out.controls = controls;
  const category = text(o.category, 20)?.toLowerCase();
  if (category && (CATEGORIES as readonly string[]).includes(category)) out.category = category as Category;
  const engine = text(o.engine, 30);
  if (engine) out.engine = engine;
  const entry = text(o.entry, 300);
  if (entry && cleanPath(entry)) out.entry = cleanPath(entry)!;
  if (typeof o.isolation === "boolean") out.isolation = o.isolation;
  if (o.score_order === "high" || o.score_order === "low") out.score_order = o.score_order;
  if (o.score_format === "points" || o.score_format === "time") out.score_format = o.score_format;
  if (typeof o.multiplayer === "boolean") out.multiplayer = o.multiplayer;
  if (Number.isInteger(o.max_players) && (o.max_players as number) >= 2 && (o.max_players as number) <= 64) out.max_players = o.max_players as number;
  const joinParam = text(o.join_param, 20);
  if (joinParam && JOIN_PARAM.test(joinParam)) out.join_param = joinParam;
  const cover = text(o.cover_image, 300);
  if (cover) out.cover_image = cover;
  if (Array.isArray(o.screenshots)) {
    const shots = o.screenshots.map((s) => text(s, 300)).filter((s): s is string => !!s).slice(0, 4);
    if (shots.length) out.screenshots = shots;
  }
  const version = typeof o.version === "number" ? String(o.version) : text(o.version, 20);
  if (version) out.version = version;
  const updateTitle = text(o.update_title, 80);
  if (updateTitle) out.update_title = updateTitle;
  const notes = Array.isArray(o.notes)
    ? o.notes.map((n) => text(n, 500)).filter(Boolean).map((n) => `- ${n!.replace(/^-\s*/, "")}`).join("\n")
    : text(o.notes, 5000);
  if (notes) out.notes = notes.slice(0, 5000);
  const folder = text(o.folder, 200);
  if (folder) out.folder = folder;
  return out;
}

/** A small fix (1.2.1) shows under its main version; see 20261113090000_small_releases.sql. */
export const isSmallVersion = (v: string) => /^v?\d+\.\d+\.[1-9]\d*$/i.test(v.trim());

/** For a GitHub Pages address: the repositories it may come from, and the folder inside. */
export function pagesRepos(playUrl: string): { repo: string; sub: string }[] {
  let u: URL;
  try {
    u = new URL(playUrl);
  } catch {
    return [];
  }
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(u.hostname);
  if (!m) return [];
  const owner = m[1];
  const parts = u.pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts.length && /\.html?$/i.test(parts[parts.length - 1])) parts.pop();
  const out: { repo: string; sub: string }[] = [];
  if (parts[0] && /^[\w.-]+$/.test(parts[0])) out.push({ repo: `${owner}/${parts[0]}`, sub: parts.slice(1).join("/") });
  out.push({ repo: `${owner}/${owner}.github.io`, sub: parts.join("/") });
  return out;
}

/** A name without its dashes, dots and capitals, to compare a game with a repository: "debt-drifter" → "debtdrifter". */
export const plainName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The name a site's address gives the game: "debtdrifter" for debtdrifter.vercel.app or www.debtdrifter.com. */
export function siteName(playUrl: string): string {
  try {
    const labels = new URL(playUrl).hostname.toLowerCase().split(".");
    return plainName(labels[0] === "www" && labels.length > 2 ? labels[1] : labels[0]);
  } catch {
    return "";
  }
}

/**
 * Which of these repositories is most likely the game's: the one its GitHub Pages address names,
 * else one named like its site or like the game. null when none fits.
 */
export function guessRepo<T extends { repo: string }>(repos: T[], playUrl: string, slug: string): T | null {
  for (const w of pagesRepos(playUrl)) {
    const hit = repos.find((r) => r.repo.toLowerCase() === w.repo.toLowerCase());
    if (hit) return hit;
  }
  if (pagesRepos(playUrl).length) return null;
  const names = [siteName(playUrl), plainName(slug)].filter((n) => n.length >= 3);
  return repos.find((r) => names.includes(plainName(r.repo.split("/")[1] ?? ""))) ?? null;
}
