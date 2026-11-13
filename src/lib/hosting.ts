// Games hosted on Toki, in the browser: reading what the developer picked (a ZIP, a folder or one
// HTML file), uploading it straight to Cloudflare with the links Toki's server hands out, and the
// smaller actions (roll back, upload keys, "fill in from a link"). Server: api/hosting.ts.
import { useEffect, useState } from "react";
import { api, ApiError } from "./ai";
import { readTokiJson, type TokiJson } from "./hostingRules";
import type { Category } from "./types";

export interface HostingStatus {
  enabled: boolean;
  domain: string | null;
  maxBytes: number;
  /** One-click add: which AI adds leaderboard code */
  quickCode?: "strong" | "off";
  /** admins only */
  source?: "env" | "toki" | null;
  accountId?: string | null;
  bucket?: string | null;
  usedBytes?: number;
  limitBytes?: number;
  hostedGames?: number;
  followingGames?: number;
  /** where the GitHub App is set up, and whether its push events can be checked */
  github?: "env" | "toki" | null;
  webhook?: boolean;
}

let status: Promise<HostingStatus> | null = null;
export const hostingStatus = (fresh = false) => {
  if (!status || fresh) status = api<HostingStatus>("/api/hosting").catch(() => ({ enabled: false, domain: null, maxBytes: 0 }));
  return status;
};

export function useHosting(): HostingStatus | null {
  const [s, setS] = useState<HostingStatus | null>(null);
  useEffect(() => {
    let live = true;
    hostingStatus().then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

export const HOST_ERRORS = [
  "no_files", "too_many_files", "too_big", "bad_file", "no_entry", "zip", "rate_limited", "storage_full", "account_full", "hosting_off",
  "missing_files", "not_allowed", "slug_taken", "no_previous", "storage_error", "too_many_keys", "upload", "error",
  "github_off", "github_error", "no_branch", "no_repo", "repo_too_big",
  "already_hosted", "move_unreachable", "move_incomplete", "move_slow", "move_no_saves", "move_engine_saves", "not_moved", "needs_build", "github_required", "repo_required", "cant_build", "repo_lost",
] as const;
export type HostErrorCode = (typeof HOST_ERRORS)[number];
/** The error to show: one Toki knows, "upload" when a file didn't reach Cloudflare, else "error". */
export function hostError(e: unknown): HostErrorCode {
  const code = typeof e === "string" ? e : e instanceof ApiError ? e.message : e instanceof PickError ? "zip" : "upload";
  return (HOST_ERRORS as readonly string[]).includes(code) ? (code as HostErrorCode) : "error";
}

export interface PickedFile {
  path: string;
  size: number;
  data: Blob;
}

export class PickError extends Error {}

/** The game's files from what was picked or dropped: a ZIP is unpacked here, in the browser. */
export async function readPicked(list: File[]): Promise<PickedFile[]> {
  if (list.length === 1 && /\.zip$/i.test(list[0].name)) {
    const { unzip } = await import("fflate");
    const buf = new Uint8Array(await list[0].arrayBuffer());
    const files = await new Promise<Record<string, Uint8Array>>((res, rej) => unzip(buf, (err, out) => (err ? rej(new PickError("zip")) : res(out))));
    return Object.entries(files)
      .filter(([path]) => !path.endsWith("/"))
      .map(([path, bytes]) => ({ path, size: bytes.length, data: new Blob([bytes as BlobPart]) }));
  }
  return list.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, data: f }));
}

/** The toki.json among the picked files (at the top, or in the one folder around everything). */
export async function findTokiJson(files: PickedFile[]): Promise<TokiJson | null> {
  const f = files
    .filter((x) => /(^|\/)toki\.json$/i.test(x.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  if (!f || f.size > 20_000) return null;
  return readTokiJson(await f.data.text());
}

export interface UploadResult {
  play_url: string;
  slug: string;
  game_url: string;
  release: { version: string; posted: boolean } | null;
}

/** Uploads the files as the game's new version and makes it live. */
export async function uploadGame(gameId: string, files: PickedFile[], isolation: boolean, onProgress: (done: number, total: number) => void): Promise<UploadResult> {
  const toki = await findTokiJson(files);
  const start = await api<{ build_id: string; uploads: { path: string; size: number; url: string }[] }>("/api/hosting", {
    method: "POST",
    body: JSON.stringify({ action: "start", game_id: gameId, toki, files: files.map((f) => ({ path: f.path, size: f.size })) }),
  });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const queue = [...start.uploads];
  const bytesTotal = start.uploads.reduce((n, u) => n + u.size, 0) || 1;
  let bytesDone = 0;
  onProgress(0, bytesTotal);
  const put = async (url: string, data: Blob) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", body: data });
        if (res.ok) return;
        if (attempt >= 3) throw new Error(`upload ${res.status}`);
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  };
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        await put(u.url, byPath.get(u.path)!.data);
        bytesDone += u.size;
        onProgress(bytesDone, bytesTotal);
      }
    }),
  );
  return api<UploadResult>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "finish", build_id: start.build_id, toki, isolation }) });
}

const post = <T>(body: Record<string, unknown>) => api<T>("/api/hosting", { method: "POST", body: JSON.stringify(body) });
export const rollBackGame = (gameId: string) => api<{ play_url: string }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "rollback", game_id: gameId }) });
/** "Move to Toki": from the game's GitHub repository, or downloaded from its link (server/migrate.ts). */
export interface MoveResult {
  play_url: string;
  from: string;
  files: number;
  bytes: number;
  /** Players' progress comes along */
  saves: boolean;
  source: "github" | "site";
  github: { repo: string; branch: string; folder: string } | null;
  /** Taken from the site: the repository whose file list helped, and how many files it added */
  repoHelped: { repo: string; files: number } | null;
  /** The repository holds the source: the game follows it now and GitHub Actions builds every push, or why it can't */
  build: (BuildSetup & { repo: string; branch: string }) | { cannot: NoBuild; repo: string } | null;
}
export interface MoveChoices {
  /** Move although players' progress stays behind */
  anyway?: boolean;
  /** The game's repository, picked by the developer */
  repo?: { installation_id: number; repo: string } | null;
}
export const moveToToki = (gameId: string, c: MoveChoices = {}) =>
  post<MoveResult>({ action: "move", game_id: gameId, anyway: !!c.anyway, ...(c.repo ? { installation_id: c.repo.installation_id, repo: c.repo.repo } : {}) });
/** Back to the old link after moving; the files on Toki are deleted. */
export const moveBack = (gameId: string) => post<{ play_url: string }>({ action: "move_back", game_id: gameId });
export interface MoveCheck {
  ok: boolean;
  problem: "no_script" | "engine_storage" | "unreachable" | null;
  engine: "Godot" | "Unity" | null;
  github: { repo: string; branch: string; folder: string } | null;
  suggestRepo: string | null;
}
/** Before an upload or a repository replaces a game's link: will players' progress come along? */
export const checkMove = (gameId: string) => post<MoveCheck>({ action: "move_check", game_id: gameId });
export const unhostGame = (gameId: string) => api<{ ok: true }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "unhost", game_id: gameId }) });
export const createUploadKey = (name: string) => api<{ id: string; key: string }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "create_key", name }) });

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  domain: string;
}
export const saveHostingConfig = (c: R2Settings) => api<{ ok: true }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "set_config", ...c }) });
export const clearHostingConfig = () => api<{ ok: true }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "clear_config" }) });
export const saveWebhookSecret = (secret: string) => api<{ ok: true }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "set_webhook_secret", secret }) });
export const testHostingConfig = () => api<{ ok: boolean; error?: string; message?: string }>("/api/hosting", { method: "POST", body: JSON.stringify({ action: "test_config" }) });

export interface Imported {
  source: "itch" | "github" | "page";
  title: string;
  description: string;
  play_url: string | null;
  thumbnail_url: string | null;
  screenshots: string[];
  category: Category | null;
  engine: string | null;
  controls: string;
  isolation: boolean | null;
  repo: string | null;
  toki: TokiJson | null;
}
export const importLink = (url: string) => api<Imported>("/api/import", { method: "POST", body: JSON.stringify({ url }) });

/** What a developer pastes into an AI agent to publish a game. */
export function agentPrompt(key: string | null, origin: string): string {
  return [
    `Publish my game on Toki (${origin}).`,
    `Read ${origin}/agents.md and follow it: make a web build if needed, add a toki.json with the game's details, and upload it with the upload script.`,
    key ? `My Toki upload key is: ${key}` : "I'll give you my Toki upload key (it starts with toki_).",
    "Keep the key secret: use it only as the TOKI_KEY environment variable or a GitHub secret, never commit it or put it in a file.",
    "When it's done, tell me the link to the game on Toki and what you changed, in plain words.",
  ].join("\n");
}

/** The GitHub Action that publishes the game on every push. */
export function githubWorkflow(origin: string, folder = "."): string {
  return `name: Publish to Toki
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # If your game must be built first, add the build steps here.
      - run: curl -fsSL ${origin}/toki-upload.mjs -o /tmp/toki-upload.mjs
      - run: node /tmp/toki-upload.mjs ${folder}
        env:
          TOKI_KEY: \${{ secrets.TOKI_KEY }}
`;
}

// ---------- following a GitHub repository ----------

export interface GitChoice {
  installation_id: number;
  repo: string;
  branch: string;
  folder: string;
}
export interface GitRow extends GitChoice {
  game_id: string;
  status: "waiting" | "deploying" | "live" | "failed";
  last_sha: string | null;
  last_message: string | null;
  error: string | null;
  updated_at: string;
  /** "action": GitHub Actions builds the game on every push (the repository holds the source) */
  build?: "none" | "action";
  /** the pull request that adds the build file, or GitHub's page to add it */
  build_pr?: string | null;
}
export const gitBranches = (installation_id: number, repo: string) => post<{ branches: string[]; default: string }>({ action: "git_branches", installation_id, repo });
/** GitHub Actions builds the game (its repository holds the source): the build file's pull request, or GitHub's page to add it. */
export interface BuildSetup {
  pr: string | null;
  manual: string | null;
  /** the repository has the build file already */
  ready: boolean;
  /** Toki started the first build itself */
  started: boolean;
}
/** Engines GitHub Actions can't build (their editor needs a license): they need an exported web build. */
export type NoBuild = "Unity" | "GameMaker" | "Construct" | "Godot C#" | "unknown";
export interface GitResult {
  ok: boolean;
  error?: string;
  play_url?: string;
  /** The repository holds the source: GitHub Actions builds it from now on */
  building?: BuildSetup;
  /** with error "cant_build": which engine */
  engine?: NoBuild;
}
export const gitConnect = (gameId: string, c: GitChoice) => post<GitResult>({ action: "git_connect", game_id: gameId, ...c });
export const gitDeploy = (gameId: string) => post<GitResult>({ action: "git_deploy", game_id: gameId });
/** Let GitHub Actions build the game on every push (server/gitBuild.ts). */
export const gitBuild = (gameId: string) => post<GitResult>({ action: "git_build", game_id: gameId });
export const gitDisconnect = (gameId: string) => post<{ ok: true }>({ action: "git_disconnect", game_id: gameId });


// ---------- one-click add ----------

export interface Proposal {
  title: string;
  description: string;
  description_de: string;
  category: Category;
  engine: string;
  controls: string;
  controls_de: string;
  score_order: "high" | "low";
  score_format: "points" | "time";
  leaderboard: boolean;
  has_scores: boolean;
  isolation: boolean;
  multiplayer: boolean;
  /** The game tells Toki its rooms already (toki.room), so friend invites work */
  has_rooms?: boolean;
  /** The game keeps progress outside localStorage, so Toki can't keep it without a copy there */
  saves_elsewhere?: boolean;
}
export interface ScanResult {
  proposal: Proposal;
  /** GitHub: the folder with the playable game (null: none found) */
  folder: string | null;
  needsBuild: boolean;
  /** whether the AI helped (else only simple checks) */
  ai: boolean;
}

const TEXT = /\.(html?|js|mjs|json|txt|md|gd|cfg)$/i;
/** The start page and a sample of the code, for the AI to read (at most about 150 KB). */
export async function scanSample(files: PickedFile[], entry: string): Promise<{ path: string; text: string }[]> {
  const rank = (p: string) =>
    (p === entry ? 1000 : 0) + (/toki\.json$/i.test(p) ? 900 : 0) + (/\.html?$/i.test(p) ? 200 : 0) + (/(game|main|play|score|level|app)/i.test(p) ? 50 : 0) - p.split("/").length;
  const out: { path: string; text: string }[] = [];
  let total = 0;
  for (const f of files.filter((x) => TEXT.test(x.path) && !/\.min\.js$/i.test(x.path)).sort((a, b) => rank(b.path) - rank(a.path))) {
    if (out.length >= 30) break;
    if (f.size > 60_000 && f.path !== entry) continue;
    const text = (await f.data.slice(0, 60_000).text());
    if (total + text.length > 150_000) continue;
    out.push({ path: f.path, text });
    total += text.length;
  }
  return out;
}

export const scanUpload = (name: string, files: PickedFile[], sample: { path: string; text: string }[]) =>
  api<ScanResult>("/api/assist", { method: "POST", body: JSON.stringify({ action: "scan", source: "upload", name, paths: files.map((f) => f.path), files: sample }) });
export const scanRepo = (installation_id: number, repo: string, branch: string) =>
  api<ScanResult>("/api/assist", { method: "POST", body: JSON.stringify({ action: "scan", source: "github", installation_id, repo, branch }) });

/**
 * Starts Toki Connect adding what the developer ticked when adding the game: saves, a
 * leaderboard, friend invites, all in one run (one new live version, or one pull request).
 */
export const startAdditions = (p: { game_id: string; lang: string; features: ("saves" | "scores" | "multiplayer")[] } & ({ source: "upload" } | { source: "github"; installation_id: number; repo: string; branch: string })) =>
  api<{ job: { id: string } }>("/api/connect", { method: "POST", body: JSON.stringify({ action: "start", quick: true, ...p }) });
