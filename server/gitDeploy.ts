// Games that follow a GitHub repository, like Vercel: on every push to the chosen branch (and
// when the developer connects it), Toki downloads that commit, takes the chosen folder and puts
// it live as the game's new version, through the same steps as any upload (server/hosting.ts).
// The repository is read with the Toki GitHub App; nothing is built (games that need a build
// step use the GitHub Action from agents.md instead).
import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Db } from "./db.js";
import { GitHubError, type GitHubClient, type RepoClient } from "./github.js";
import { finishUpload, HostingError, startUpload, type Deps, type HostUser } from "./hosting.js";
import { cleanPath, MAX_GAME_BYTES, readTokiJson } from "../src/lib/hostingRules.js";
import { isSourcePage } from "./assist/scan.js";

/** Repositories with more than this (packed) can't follow; a game is at most 100 MB anyway. */
export const MAX_TARBALL = 250 * 1024 * 1024;

export interface TarFile {
  path: string;
  data: Uint8Array;
}

const str = (b: Uint8Array, start: number, len: number) => {
  const part = b.subarray(start, start + len);
  const end = part.indexOf(0);
  return new TextDecoder().decode(end < 0 ? part : part.subarray(0, end));
};

/** The files in a .tar (GitHub's tarballs: ustar with pax headers for long names). */
export function readTar(tar: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= tar.length) {
    const head = tar.subarray(pos, pos + 512);
    if (head.every((x) => x === 0)) break;
    const size = parseInt(str(head, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(head[156] || 48);
    const prefix = str(head, 345, 155);
    let name = str(head, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const body = tar.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // "<length> path=<name>\n" records
      for (const rec of new TextDecoder().decode(body).split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) longName = m[1];
      }
      continue;
    }
    if (type === "L") {
      longName = str(body, 0, body.length);
      continue;
    }
    if (type === "g") continue;
    if (longName) name = longName;
    longName = null;
    if (type === "0" || type === "\0" || type === "7") out.push({ path: name, data: body });
  }
  return out;
}

/** The files inside `folder` of the repository (GitHub puts everything in one top folder). */
export function filesIn(files: TarFile[], folder: string): TarFile[] {
  const want = folder.replace(/^\/+|\/+$/g, "");
  const out: TarFile[] = [];
  for (const f of files) {
    const rest = f.path.slice(f.path.indexOf("/") + 1); // drop "owner-repo-sha/"
    if (want && !rest.startsWith(`${want}/`)) continue;
    const path = cleanPath(want ? rest.slice(want.length + 1) : rest);
    if (path) out.push({ path, data: f.data });
  }
  return out;
}

/** Whether these files (the top of a repository) are a project that a build turns into the game. */
export function isSource(root: TarFile[]): boolean {
  if (root.some((f) => f.path === "project.godot")) return true;
  const pkg = root.find((f) => f.path === "package.json");
  return !!pkg && new TextDecoder().decode(pkg.data).includes('"build"');
}

export interface GitRow {
  game_id: string;
  installation_id: number;
  repo: string;
  branch: string;
  folder: string;
  created_by: string | null;
}

const short = (e: unknown) => {
  if (e instanceof HostingError) return e.code;
  if (e instanceof GitHubError) {
    if (e.message === "repo_too_big") return "repo_too_big";
    // GitHub itself had a problem, or didn't answer: trying again later helps.
    if (e.status >= 500 || e.status === 429 || /rate limit/i.test(e.message)) return "github_error";
    return `github: ${e.message}`.slice(0, 300);
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "github_error";
  return e instanceof Error ? e.message.slice(0, 300) : "error";
};

/**
 * Whether GitHub says this connection can't reach the repository: the Toki app was uninstalled
 * (installing it again gives it a new id), it is suspended, or the repository was taken out of it.
 */
const lost = (e: unknown) => e instanceof GitHubError && (e.status === 404 || (e.status === 403 && !/rate limit/i.test(e.message)));

/**
 * The game's repository, through a GitHub connection that still reaches it. When the one saved
 * with the game doesn't any more, the developer's other connections are tried, and the one that
 * works is saved for next time (also a new name, when the repository was renamed). Throws
 * "repo_lost" when none of them reaches it.
 */
export async function openRepo(db: Db, gh: GitHubClient, row: GitRow, ownerId?: string | null): Promise<RepoClient> {
  const tried = new Set<number>();
  const reach = async (id: number): Promise<RepoClient> => {
    tried.add(id);
    let repo = await gh.repo(id, row.repo);
    const name = await repo.name();
    if (Number(row.installation_id) !== id || name !== row.repo) {
      if (name !== row.repo) repo = await gh.repo(id, name);
      row.installation_id = id;
      row.repo = name;
      await db.update("game_git", `game_id=eq.${row.game_id}`, { installation_id: id, repo: name }).catch(() => {});
    }
    return repo;
  };
  try {
    return await reach(Number(row.installation_id));
  } catch (e) {
    if (!lost(e)) throw e;
  }
  const users = [...new Set([ownerId, row.created_by].filter((u): u is string => !!u))];
  const mine = users.length ? await db.select<{ installation_id: number }>("github_installations", `user_id=in.(${users.join(",")})&select=installation_id`) : [];
  for (const id of new Set(mine.map((i) => Number(i.installation_id)))) {
    if (tried.has(id)) continue;
    try {
      return await reach(id);
    } catch (e) {
      if (!lost(e)) throw e;
    }
  }
  throw new HostingError("repo_lost", 404);
}

/**
 * Deploys one commit of a game's repository. Records how it went on the game's game_git row
 * (overwritten each time) and never throws.
 */
export async function deployCommit(deps: Deps, gh: GitHubClient, row: GitRow, commit?: { sha: string; message: string }, put: typeof fetch = fetch): Promise<{ ok: boolean; error?: string; play_url?: string }> {
  const { db } = deps;
  const mark = (patch: Record<string, unknown>) => db.update("game_git", `game_id=eq.${row.game_id}`, { ...patch, updated_at: new Date().toISOString() }).catch(() => {});
  try {
    const user = await owner(db, row);
    const repo = await openRepo(db, gh, row, user.id);
    const head =
      commit ??
      (await repo.head(row.branch).catch((e) => {
        throw e instanceof GitHubError && (e.status === 404 || e.status === 422) ? new HostingError("no_branch") : e;
      }));
    await mark({ status: "deploying", last_sha: head.sha, last_message: head.message || null, error: null });
    const all = readTar(gunzipSync(await repo.tarball(head.sha, MAX_TARBALL), { maxOutputLength: 1024 ** 3 }));
    // toki.json at the top of the repository may name the folder ("folder": "build").
    let folder = row.folder;
    const rootToki = filesIn(all, "").find((f) => f.path === "toki.json");
    if (!folder && rootToki) folder = readTokiJson(new TextDecoder().decode(rootToki.data)).folder ?? "";
    const files = filesIn(all, folder);
    // The folder isn't in the repository, but the game's source is: the folder is where the
    // build puts the game ("dist", "build"). It has to be built first, like below.
    if (!files.length && folder && isSource(filesIn(all, ""))) throw new HostingError("needs_build");
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > MAX_GAME_BYTES) throw new HostingError("too_big");
    const tokiFile = files.find((f) => f.path === "toki.json") ?? rootToki;
    const toki = tokiFile ? readTokiJson(new TextDecoder().decode(tokiFile.data)) : {};
    // The game's source instead of the finished game (its page loads ./src/main.ts): it would
    // go live and not run. It has to be built first (a GitHub Action does that, see agents.md).
    const page = files.find((f) => f.path === (toki.entry ?? "index.html"));
    const pkg = files.find((f) => f.path === "package.json") ?? filesIn(all, "").find((f) => f.path === "package.json");
    const hasBuild = !!pkg && new TextDecoder().decode(pkg.data).includes('"build"');
    if (page && isSourcePage(new TextDecoder().decode(page.data.subarray(0, 200_000)), hasBuild)) throw new HostingError("needs_build");

    const start = await startUpload(deps, user, { game_id: row.game_id, toki, files: files.map((f) => ({ path: f.path, size: f.data.length })) });
    const byPath = new Map(files.map((f) => [f.path, f.data]));
    const queue = [...start.uploads];
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (let u = queue.shift(); u; u = queue.shift()) {
          const data = byPath.get(u.path)!;
          for (let attempt = 1; ; attempt++) {
            const res = await put(u.url, { method: "PUT", body: data as BodyInit, signal: AbortSignal.timeout(60_000) }).catch(() => null);
            if (res?.ok) break;
            if (attempt >= 3) throw new Error(`upload of ${u.path} failed`);
          }
        }
      }),
    );
    const done = await finishUpload(deps, user, { build_id: start.build_id, toki });
    await mark({ status: "live", error: null });
    return { ok: true, play_url: done.play_url };
  } catch (e) {
    const error = short(e);
    await mark({ status: "failed", error });
    return { ok: false, error };
  }
}

/** The game's developer, who must still be a developer for it to deploy. */
async function owner(db: Db, row: GitRow): Promise<HostUser> {
  const [g] = await db.select<{ created_by: string | null }>("games", `id=eq.${row.game_id}&select=created_by`);
  const id = g?.created_by;
  if (!id) throw new HostingError("no_game");
  const [p] = await db.select<HostUser>("profiles", `id=eq.${id}&select=id,role`);
  if (!p || p.role === "player") throw new HostingError("not_allowed");
  return p;
}

/** Whether a webhook really comes from GitHub (signed with the app's webhook secret). */
export function validSignature(secret: string, body: string, header: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface PushEvent {
  ref?: string;
  after?: string;
  deleted?: boolean;
  head_commit?: { message?: string } | null;
  repository?: { full_name?: string };
  installation?: { id?: number };
}

/** The games a push should update: same repository, same branch, same installation. */
export async function gamesForPush(db: Db, ev: PushEvent): Promise<{ rows: GitRow[]; commit: { sha: string; message: string } } | null> {
  const branch = ev.ref?.startsWith("refs/heads/") ? ev.ref.slice(11) : null;
  const repo = ev.repository?.full_name;
  if (!branch || !repo || ev.deleted || !ev.after || !/^[0-9a-f]{40}$/.test(ev.after) || /^0+$/.test(ev.after)) return null;
  // Games built by GitHub Actions upload by themselves (api/hosting.ts): leave them alone here.
  const rows = await db.select<GitRow>(
    "game_git",
    `repo=eq.${encodeURIComponent(repo)}&branch=eq.${encodeURIComponent(branch)}&build=eq.none&select=game_id,installation_id,repo,branch,folder,created_by`,
  );
  const from = ev.installation?.id;
  if (!rows.length || typeof from !== "number") return null;
  // A game saved with an older connection (the Toki app was installed again on GitHub, which
  // gives it a new id) follows this push too, when this connection is one of its developer's.
  const others = rows.filter((r) => Number(r.installation_id) !== from && r.created_by);
  const owners = others.length
    ? new Set((await db.select<{ user_id: string }>("github_installations", `installation_id=eq.${from}&select=user_id`)).map((i) => i.user_id))
    : new Set<string>();
  const mine: GitRow[] = [];
  for (const r of rows) {
    if (Number(r.installation_id) === from) mine.push(r);
    else if (r.created_by && owners.has(r.created_by)) {
      await db.update("game_git", `game_id=eq.${r.game_id}`, { installation_id: from }).catch(() => {});
      mine.push({ ...r, installation_id: from });
    }
  }
  if (!mine.length) return null;
  return { rows: mine, commit: { sha: ev.after, message: (ev.head_commit?.message ?? "").split("\n")[0].trim().slice(0, 200) } };
}
