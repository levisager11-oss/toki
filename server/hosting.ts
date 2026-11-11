// Games hosted on Toki (see supabase/migrations/20261115090000_game_hosting.sql):
// 1. start: the uploader lists its files; Toki checks them and hands out one upload link per file.
// 2. The files go straight to Cloudflare R2 (from the browser, the upload script or a GitHub Action).
// 3. finish: Toki checks what arrived, points the game's address at the new version, keeps the
//    version before for 30 days, and takes over what the game's toki.json says.
// Files are kept as b/<build id>/<path>; sites/<site>.json tells the Worker which build is live.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { decrypt } from "./secrets.js";
import { r2, r2Configured, type R2, type R2Config } from "./r2.js";
import {
  isHostedUrl, isSmallVersion, KEEP_PREVIOUS_DAYS, MAX_GAME_BYTES, planFiles, readTokiJson, siteFor, siteUrl, type PlanError, type TokiJson,
} from "../src/lib/hostingRules.js";

/** All games together stay below Cloudflare's free 10 GB. */
export const BUCKET_BYTES = 9.5 * 1024 ** 3;
/** One developer's games together (admins have no limit). */
export const ACCOUNT_BYTES = 1024 ** 3;
/** Uploads started per account and hour. */
export const STARTS_PER_HOUR = 30;

export type Role = "admin" | "creator" | "player";
export interface HostUser {
  id: string;
  role: Role;
}

export class HostingError extends Error {
  /** `detail`: more for the person to read (e.g. which file names), passed on as the answer's message */
  constructor(readonly code: string, readonly status = 400, readonly detail = "") {
    super(code);
  }
}

const env = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Cloudflare settings: Vercel's environment variables win, else what an admin saved on Toki. */
export async function r2Config(db: Db, serviceKey: string): Promise<{ config: R2Config | null; source: "env" | "toki" | null }> {
  const e = env();
  const fromEnv = {
    accountId: e.R2_ACCOUNT_ID ?? "",
    accessKeyId: e.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: e.R2_SECRET_ACCESS_KEY ?? "",
    bucket: e.R2_BUCKET ?? "",
    domain: e.GAMES_DOMAIN ?? "",
  };
  if (r2Configured(fromEnv)) return { config: fromEnv, source: "env" };
  const [row] = await db.select<{ value: string }>("server_secrets", "name=eq.cloudflare_r2&select=value");
  const plain = row && decrypt(row.value, serviceKey);
  if (!plain) return { config: null, source: null };
  try {
    const c = JSON.parse(plain) as R2Config;
    return r2Configured(c) ? { config: c, source: "toki" } : { config: null, source: null };
  } catch {
    return { config: null, source: null };
  }
}

// ---------- upload keys ----------

export const KEY_PREFIX = "toki_";
export const MAX_KEYS = 5;
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newKey = () => `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
export const isUploadKey = (v: string) => /^toki_[A-Za-z0-9_-]{32}$/.test(v);

// ---------- games ----------

interface GameRow {
  id: string;
  slug: string;
  title: string;
  created_by: string | null;
  hosted_site: string | null;
  needs_isolation: boolean;
  thumbnail_url: string | null;
  screenshots: string[];
  play_url?: string;
}
const GAME_COLS = "id,slug,title,created_by,hosted_site,needs_isolation,thumbnail_url,screenshots,play_url";

export function slugify(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

const may = (user: HostUser, g: { created_by: string | null }) => user.role === "admin" || g.created_by === user.id;

/**
 * The game to upload to: by id, or by slug. An upload key may create a new game from its
 * toki.json (a title is enough) when no game has that slug yet.
 */
async function findOrCreateGame(db: Db, user: HostUser, b: { game_id?: unknown; slug?: unknown }, toki: TokiJson, domain: string): Promise<{ game: GameRow; created: boolean }> {
  if (typeof b.game_id === "string") {
    if (!/^[0-9a-f-]{36}$/i.test(b.game_id)) throw new HostingError("bad_request");
    const [g] = await db.select<GameRow>("games", `id=eq.${b.game_id}&select=${GAME_COLS}`);
    if (!g) throw new HostingError("no_game", 404);
    if (!may(user, g)) throw new HostingError("not_allowed", 403);
    return { game: g, created: false };
  }
  const slug = typeof b.slug === "string" && b.slug ? b.slug.toLowerCase() : toki.slug ?? (toki.title ? slugify(toki.title) : "");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) throw new HostingError("no_game", 404);
  const s = encodeURIComponent(slug);
  const [g] = await db.select<GameRow>("games", `or=(slug.eq.${s},old_slugs.cs.%7B${s}%7D)&select=${GAME_COLS}&limit=1`);
  if (g) {
    if (!may(user, g)) throw new HostingError("slug_taken", 409);
    return { game: g, created: false };
  }
  const title = toki.title ?? slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const [created] = await db.insert<GameRow>(
    "games",
    {
      slug,
      title,
      category: toki.category ?? "other",
      play_url: siteUrl(siteFor(slug), domain),
      created_by: user.id,
      description: toki.description ?? "",
      description_de: toki.description_de ?? null,
      controls: toki.controls ?? "",
      controls_de: toki.controls_de ?? null,
      engine: toki.engine ?? null,
    },
  );
  return { game: { ...created, screenshots: created.screenshots ?? [] }, created: true };
}

/** Gives the game its address the first time it is hosted. */
async function ensureSite(db: Db, game: GameRow): Promise<string> {
  if (game.hosted_site) return game.hosted_site;
  for (let attempt = 0; attempt < 5; attempt++) {
    const site = siteFor(game.slug, attempt);
    try {
      const [row] = await db.update<{ hosted_site: string }>("games", `id=eq.${game.id}&hosted_site=is.null`, { hosted_site: site });
      if (row) return row.hosted_site;
      const [again] = await db.select<{ hosted_site: string | null }>("games", `id=eq.${game.id}&select=hosted_site`);
      if (again?.hosted_site) return again.hosted_site;
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e; // another game has that name: try another
    }
  }
  throw new HostingError("error", 500);
}

// ---------- start ----------

export interface Deps {
  db: Db;
  store: R2;
  config: R2Config;
  now?: () => Date;
}

const PLAN_STATUS: Record<PlanError, number> = { no_files: 400, too_many_files: 413, too_big: 413, bad_file: 400, no_entry: 400 };

export async function startUpload(deps: Deps, user: HostUser, b: Record<string, unknown>) {
  const { db, store, config } = deps;
  const now = deps.now?.() ?? new Date();
  if (user.role === "player") throw new HostingError("not_allowed", 403);
  const toki = readTokiJson(b.toki);
  const files = Array.isArray(b.files) ? (b.files as { path: string; size: number }[]) : [];
  if (files.length > 20_000) throw new HostingError("too_many_files", 413);
  const plan = planFiles(files, toki.entry);
  if ("error" in plan) throw new HostingError(plan.error, PLAN_STATUS[plan.error]);

  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const recent = await db.select<{ id: string }>("game_builds", `created_by=eq.${user.id}&created_at=gt.${hourAgo}&select=id&limit=${STARTS_PER_HOUR}`);
  if (recent.length >= STARTS_PER_HOUR) throw new HostingError("rate_limited", 429);

  const kept = await db.select<{ bytes: number; created_by: string | null }>("game_builds", "status=in.(uploading,live,previous)&select=bytes,created_by");
  const total = kept.reduce((n, r) => n + Number(r.bytes), 0);
  if (total + plan.bytes > BUCKET_BYTES) throw new HostingError("storage_full", 507);
  if (user.role !== "admin") {
    const mine = kept.filter((r) => r.created_by === user.id).reduce((n, r) => n + Number(r.bytes), 0);
    if (mine + plan.bytes > ACCOUNT_BYTES) throw new HostingError("account_full", 507);
  }

  const { game, created } = await findOrCreateGame(db, user, b, toki, config.domain);
  const site = await ensureSite(db, game);
  // An upload that was started before and never finished: its files go.
  await db.update("game_builds", `game_id=eq.${game.id}&status=eq.uploading`, { status: "deleting", delete_after: now.toISOString() });
  const [build] = await db.insert<{ id: string }>("game_builds", {
    game_id: game.id, site, created_by: user.id, status: "uploading", files: plan.files.length, bytes: plan.bytes, entry: plan.entry, version: toki.version ?? null,
  });
  const uploads = plan.files.map((f) => ({ path: f.from, size: f.size, url: store.uploadUrl(`b/${build.id}/${f.path}`, f.size, now) }));
  return { build_id: build.id, game_id: game.id, slug: game.slug, created, site, entry: plan.entry, bytes: plan.bytes, uploads };
}

// ---------- finish ----------

interface BuildRow {
  id: string;
  game_id: string;
  site: string;
  status: string;
  entry: string;
  created_by: string | null;
  bytes: number;
}

async function pointTo(store: R2, site: string, build: { id: string; entry: string }, isolation: boolean) {
  await store.put(`sites/${site}.json`, JSON.stringify({ build: build.id, entry: build.entry, isolation }));
}

/** A picture named in toki.json: a file of the game (by its address) or an https link. */
function picture(ref: string | undefined, base: string): string | undefined {
  if (!ref) return undefined;
  if (/^https:\/\//i.test(ref)) return ref.slice(0, 500);
  const path = ref.replace(/^\.?\/+/, "");
  if (!path || path.includes("..")) return undefined;
  return `${base}${path.split("/").map(encodeURIComponent).join("/")}`.slice(0, 500);
}

export async function finishUpload(deps: Deps, user: HostUser, b: Record<string, unknown>) {
  const { db, store, config } = deps;
  const now = deps.now?.() ?? new Date();
  if (typeof b.build_id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.build_id)) throw new HostingError("bad_request");
  const [build] = await db.select<BuildRow>("game_builds", `id=eq.${b.build_id}&select=id,game_id,site,status,entry,created_by,bytes`);
  if (!build) throw new HostingError("no_build", 404);
  if (build.created_by !== user.id && user.role !== "admin") throw new HostingError("not_allowed", 403);
  if (build.status !== "uploading") throw new HostingError("not_uploading", 409);
  const [game] = await db.select<GameRow>("games", `id=eq.${build.game_id}&select=${GAME_COLS}`);
  if (!game) throw new HostingError("no_game", 404);
  if (!may(user, game)) throw new HostingError("not_allowed", 403);

  const objects = await store.list(`b/${build.id}/`);
  const bytes = objects.reduce((n, o) => n + o.size, 0);
  const has = new Set(objects.map((o) => o.key.slice(`b/${build.id}/`.length)));
  if (!objects.length || !has.has(build.entry)) throw new HostingError("missing_files", 400);
  if (bytes > MAX_GAME_BYTES || bytes > Number(build.bytes) + 1024) {
    await db.update("game_builds", `id=eq.${build.id}`, { status: "deleting", delete_after: now.toISOString() });
    throw new HostingError("too_big", 413);
  }

  const toki = readTokiJson(b.toki);
  const isolation = typeof b.isolation === "boolean" ? b.isolation : toki.isolation ?? game.needs_isolation ?? false;
  await pointTo(store, build.site, build, isolation);

  // The live version becomes the one to roll back to; anything older goes now.
  const keepUntil = new Date(now.getTime() + KEEP_PREVIOUS_DAYS * 86400_000).toISOString();
  await db.update("game_builds", `game_id=eq.${game.id}&status=eq.previous`, { status: "deleting", delete_after: now.toISOString() });
  await db.update("game_builds", `game_id=eq.${game.id}&status=eq.live`, { status: "previous", delete_after: keepUntil });
  await db.update("game_builds", `id=eq.${build.id}`, { status: "live", live_at: now.toISOString(), files: objects.length, bytes, delete_after: null });

  const playUrl = siteUrl(build.site, config.domain, build.entry);
  const base = siteUrl(build.site, config.domain);
  const patch: Record<string, unknown> = { play_url: playUrl, needs_isolation: isolation };
  // The game ran at a link elsewhere until now: Toki remembers it, so players' progress comes
  // along from there (src/lib/movedSaves.ts), however the game moved (upload, GitHub, Move to Toki).
  if (game.play_url && /^https:\/\//i.test(game.play_url) && !isHostedUrl(game.play_url, config.domain)) {
    patch.moved_from = game.play_url.slice(0, 500);
    patch.moved_at = now.toISOString();
  }
  if (toki.title) patch.title = toki.title;
  if (toki.description) patch.description = toki.description;
  if (toki.description_de) patch.description_de = toki.description_de;
  if (toki.controls) patch.controls = toki.controls;
  if (toki.controls_de) patch.controls_de = toki.controls_de;
  if (toki.category) patch.category = toki.category;
  if (toki.engine) patch.engine = toki.engine;
  if (toki.score_order) patch.score_order = toki.score_order;
  if (toki.score_format) patch.score_format = toki.score_format;
  if (toki.multiplayer !== undefined) patch.multiplayer = toki.multiplayer;
  if (toki.max_players) patch.max_players = toki.max_players;
  if (toki.join_param) patch.join_param = toki.join_param;
  const cover = picture(toki.cover_image, base);
  if (cover) patch.thumbnail_url = cover;
  const shots = toki.screenshots?.map((s) => picture(s, base)).filter((s): s is string => !!s);
  if (shots?.length) patch.screenshots = shots;
  await db.update("games", `id=eq.${game.id}`, patch);
  // Achievements in toki.json: new ones are added and listed ones updated; none are deleted, so
  // an upload never takes badges away from players.
  if (toki.achievements?.length) {
    await db.rpc("set_achievements", { p_game: game.id, p_list: toki.achievements, p_mode: "merge" }).catch(() => {});
  }

  let release: { version: string; posted: boolean } | null = null;
  if (toki.version) {
    const v = encodeURIComponent(toki.version);
    const [had] = await db.select<{ id: string }>("game_releases", `game_id=eq.${game.id}&version=eq.${v}&select=id`);
    if (!had) {
      await db.insert(
        "game_releases",
        { game_id: game.id, version: toki.version, title: toki.update_title ?? null, notes: toki.notes ?? "", small: isSmallVersion(toki.version), created_by: user.id },
        "return=minimal",
      );
    }
    release = { version: toki.version, posted: !had };
  }

  await sweep(deps, 20).catch(() => {}); // tidying up must never fail an upload
  return { play_url: playUrl, slug: game.slug, game_url: `/game/${game.slug}`, files: objects.length, bytes, release };
}

// ---------- roll back ----------

export async function rollBack(deps: Deps, user: HostUser, b: Record<string, unknown>) {
  const { db, store, config } = deps;
  const now = deps.now?.() ?? new Date();
  if (typeof b.game_id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.game_id)) throw new HostingError("bad_request");
  const [game] = await db.select<GameRow>("games", `id=eq.${b.game_id}&select=${GAME_COLS}`);
  if (!game) throw new HostingError("no_game", 404);
  if (!may(user, game)) throw new HostingError("not_allowed", 403);
  const [prev] = await db.select<BuildRow>("game_builds", `game_id=eq.${game.id}&status=eq.previous&delete_after=gt.${now.toISOString()}&select=id,game_id,site,status,entry,created_by,bytes&order=created_at.desc&limit=1`);
  if (!prev) throw new HostingError("no_previous", 404);
  await pointTo(store, prev.site, prev, game.needs_isolation);
  const keepUntil = new Date(now.getTime() + KEEP_PREVIOUS_DAYS * 86400_000).toISOString();
  await db.update("game_builds", `game_id=eq.${game.id}&status=eq.live`, { status: "previous", delete_after: keepUntil });
  await db.update("game_builds", `id=eq.${prev.id}`, { status: "live", live_at: now.toISOString(), delete_after: null });
  const playUrl = siteUrl(prev.site, config.domain, prev.entry);
  await db.update("games", `id=eq.${game.id}`, { play_url: playUrl });
  return { play_url: playUrl };
}

// ---------- clean-up ----------

/** Deletes the files of versions that are due (replaced 30 days ago, unfinished, or of deleted games). */
export async function sweep(deps: Deps, limit = 100): Promise<{ deleted: number }> {
  const { db, store } = deps;
  const now = deps.now?.() ?? new Date();
  const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
  await db.update("game_builds", `status=eq.uploading&created_at=lt.${dayAgo}`, { status: "deleting", delete_after: now.toISOString() });
  const due = await db.select<{ id: string; site: string; status: string }>(
    "game_builds",
    `delete_after=lte.${now.toISOString()}&status=neq.live&select=id,site,status&order=delete_after&limit=${limit}`,
  );
  let deleted = 0;
  for (const d of due) {
    const keys = (await store.list(`b/${d.id}/`)).map((o) => o.key);
    if (keys.length) await store.removeMany(keys);
    // A deleted game: its address stops working too (unless another game has the name by now).
    const [owner] = await db.select<{ id: string }>("games", `hosted_site=eq.${encodeURIComponent(d.site)}&select=id`);
    if (!owner) await store.remove(`sites/${d.site}.json`);
    await db.remove("game_builds", `id=eq.${d.id}`);
    deleted++;
  }
  return { deleted };
}

export const hostingDeps = (db: Db, config: R2Config, fetchImpl: typeof fetch = fetch): Deps => ({ db, store: r2(config, fetchImpl), config });
