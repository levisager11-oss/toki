// Games hosted on Toki: uploads (from the website, the upload script, GitHub Actions or AI agents),
// rolling back, upload keys, the admin's Cloudflare settings, and the nightly clean-up.
// The logic is in server/hosting.ts; the files themselves never pass through here.
import { SUPABASE_KEY, SUPABASE_URL } from "../server/config.js";
import { serviceDb, type Db } from "../server/db.js";
import { serverEnv } from "../server/env.js";
import {
  finishUpload, hashKey, HostingError, hostingDeps, isUploadKey, KEY_PREFIX, MAX_KEYS, newKey, r2Config, rollBack, startUpload, sweep, type HostUser,
} from "../server/hosting.js";
import { body, isUuid, json } from "../server/http.js";
import { r2, r2Configured, R2Error, type R2Config } from "../server/r2.js";
import { removeSecret, saveSecret, withSecrets } from "../server/secrets.js";
import { githubConfigured } from "../server/env.js";
import { deployCommit, type GitRow } from "../server/gitDeploy.js";
import { github, GitHubError } from "../server/github.js";
import { MAX_GAME_BYTES } from "../src/lib/hostingRules.js";

interface Who {
  db: Db;
  serviceKey: string;
  user: HostUser & { username: string };
  /** Logged in on the website (not with an upload key) */
  session: boolean;
}

/** The account behind a login (Bearer <Supabase token>) or an upload key (Bearer toki_…). */
async function who(request: Request): Promise<Who | Response> {
  const env = serverEnv();
  if (!env.serviceKey) return json({ error: "not_configured" }, 503);
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "login_required" }, 401);
  const db = serviceDb(env.serviceKey);
  let id: string | undefined;
  let session = false;
  if (token.startsWith(KEY_PREFIX)) {
    if (!isUploadKey(token)) return json({ error: "bad_key" }, 401);
    const [key] = await db.select<{ id: string; user_id: string }>("upload_keys", `key_hash=eq.${hashKey(token)}&select=id,user_id`);
    if (!key) return json({ error: "bad_key" }, 401);
    id = key.user_id;
    await db.update("upload_keys", `id=eq.${key.id}`, { last_used_at: new Date().toISOString() }).catch(() => {});
  } else {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } });
    if (!res.ok) return json({ error: "login_required" }, 401);
    id = ((await res.json()) as { id?: string }).id;
    session = true;
  }
  if (!isUuid(id)) return json({ error: "login_required" }, 401);
  const [profile] = await db.select<Who["user"]>("profiles", `id=eq.${id}&select=id,username,role`);
  if (!profile || profile.role === "player") return json({ error: "not_allowed" }, 403);
  return { db, serviceKey: env.serviceKey, user: profile, session };
}

function failed(e: unknown): Response {
  if (e instanceof HostingError) return json({ error: e.code }, e.status);
  if (e instanceof R2Error) return json({ error: "storage_error", message: e.message.slice(0, 200) }, 502);
  return json({ error: "error" }, 500);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Vercel's nightly job (vercel.json). Harmless to call: it only deletes what is due.
  if (url.searchParams.get("action") === "sweep") {
    const env = serverEnv();
    if (!env.serviceKey) return json({ error: "not_configured" }, 503);
    const db = serviceDb(env.serviceKey);
    const { config } = await r2Config(db, env.serviceKey);
    if (!config) return json({ deleted: 0 });
    try {
      return json(await sweep(hostingDeps(db, config), 200));
    } catch (e) {
      return failed(e);
    }
  }
  const w = await who(request);
  if (w instanceof Response) return w;
  const { config, source } = await r2Config(w.db, w.serviceKey);
  const out: Record<string, unknown> = { enabled: !!config, domain: config?.domain ?? null, maxBytes: MAX_GAME_BYTES };
  // One-click add: which AI adds leaderboard code ("off" when it isn't set up).
  const [ai] = await w.db.select<{ quick_code_ai: string; enabled: boolean; free_enabled: boolean }>("ai_settings", "id=eq.1&select=quick_code_ai,enabled,free_enabled");
  out.quickCode = !ai || ai.quick_code_ai === "off" ? "off" : ai.quick_code_ai === "free" ? (ai.free_enabled ? "free" : "off") : ai.enabled ? "strong" : "off";
  if (w.user.role === "admin") {
    out.source = source;
    out.accountId = config?.accountId ?? null;
    out.bucket = config?.bucket ?? null;
  }
  return json(out);
}

export async function POST(request: Request) {
  const w = await who(request);
  if (w instanceof Response) return w;
  const b = await body(request);

  // Settings, keys and GitHub: only when logged in on the website.
  const SESSION_ONLY = ["create_key", "set_config", "clear_config", "test_config", "set_webhook_secret", "git_branches", "git_connect", "git_deploy", "git_disconnect"];
  if (typeof b.action === "string" && SESSION_ONLY.includes(b.action)) {
    if (!w.session) return json({ error: "not_allowed" }, 403);
    if (b.action === "create_key") return createKey(w, b);
    if (b.action.startsWith("git_")) {
      try {
        return await git(w, b);
      } catch (e) {
        if (e instanceof GitHubError) return json({ error: "github_error", message: e.message.slice(0, 200) }, 502);
        return failed(e);
      }
    }
    if (w.user.role !== "admin") return json({ error: "not_allowed" }, 403);
    if (b.action === "set_webhook_secret") return setWebhookSecret(w, b);
    if (b.action === "clear_config") {
      await removeSecret(w.db, "cloudflare_r2");
      return json({ ok: true });
    }
    if (b.action === "test_config") return testConfig(w);
    return setConfig(w, b);
  }

  const { config } = await r2Config(w.db, w.serviceKey);
  if (!config) return json({ error: "hosting_off" }, 503);
  const deps = hostingDeps(w.db, config);
  try {
    switch (b.action) {
      case "start":
        return json(await startUpload(deps, w.user, b));
      case "finish":
        return json(await finishUpload(deps, w.user, b));
      case "rollback":
        return json(await rollBack(deps, w.user, b));
      case "unhost":
        return json(await unhost(w, deps.store, b));
      default:
        return json({ error: "bad_request" }, 400);
    }
  } catch (e) {
    return failed(e);
  }
}

async function createKey(w: Who, b: Record<string, unknown>) {
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 40) : "";
  if (!name) return json({ error: "bad_request" }, 400);
  const mine = await w.db.select<{ id: string }>("upload_keys", `user_id=eq.${w.user.id}&select=id`);
  if (mine.length >= MAX_KEYS) return json({ error: "too_many_keys" }, 409);
  const key = newKey();
  const [row] = await w.db.insert<{ id: string }>("upload_keys", { user_id: w.user.id, name, key_hash: hashKey(key), hint: key.slice(-4) });
  return json({ id: row.id, key });
}

const field = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v.trim()) ? v.trim() : "");

async function setConfig(w: Who, b: Record<string, unknown>) {
  const domain = field(b.domain, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i).toLowerCase();
  const c: R2Config = {
    accountId: field(b.accountId, /^[0-9a-f]{32}$/i),
    accessKeyId: field(b.accessKeyId, /^[A-Za-z0-9]{16,128}$/),
    secretAccessKey: field(b.secretAccessKey, /^[A-Za-z0-9]{16,128}$/),
    bucket: field(b.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    domain,
  };
  if (!r2Configured(c)) return json({ error: "bad_request" }, 400);
  await saveSecret(w.db, { ...serverEnv(), serviceKey: w.serviceKey }, "cloudflare_r2", JSON.stringify(c), w.user.id);
  return json({ ok: true });
}

/** Writes, reads back and deletes a small file, so the admin knows the keys work. */
async function testConfig(w: Who) {
  const { config } = await r2Config(w.db, w.serviceKey);
  if (!config) return json({ ok: false, error: "hosting_off" });
  const store = r2(config);
  try {
    await store.put("test/toki-check.json", JSON.stringify({ at: new Date().toISOString() }));
    const listed = await store.list("test/");
    await store.remove("test/toki-check.json");
    return json({ ok: listed.some((o) => o.key === "test/toki-check.json") });
  } catch (e) {
    return json({ ok: false, error: "storage_error", message: e instanceof Error ? e.message.slice(0, 200) : "" });
  }
}

/** The game moved to a link elsewhere: its hosted versions are deleted at the next clean-up. */
async function unhost(w: Who, store: ReturnType<typeof r2>, b: Record<string, unknown>) {
  if (!isUuid(b.game_id)) return json({ error: "bad_request" }, 400);
  const [g] = await w.db.select<{ id: string; created_by: string | null; hosted_site: string | null }>("games", `id=eq.${b.game_id}&select=id,created_by,hosted_site`);
  if (!g) return json({ error: "no_game" }, 404);
  if (g.created_by !== w.user.id && w.user.role !== "admin") return json({ error: "not_allowed" }, 403);
  await w.db.update("game_builds", `game_id=eq.${g.id}`, { status: "deleting", delete_after: new Date().toISOString() });
  if (g.hosted_site) await store.remove(`sites/${g.hosted_site}.json`);
  await w.db.remove("game_git", `game_id=eq.${g.id}`);
  return { ok: true };
}

// ---------- games that follow a GitHub repository ----------

const BRANCH = /^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/;

async function git(w: Who, b: Record<string, unknown>): Promise<Response> {
  const { env } = await withSecrets(w.db, { ...serverEnv(), serviceKey: w.serviceKey });
  if (!githubConfigured(env.github)) return json({ error: "github_off" }, 503);
  const gh = github(env.github);
  const installs = await w.db.select<{ installation_id: number }>("github_installations", `user_id=eq.${w.user.id}&select=installation_id`);
  const mayUse = (id: unknown) => typeof id === "number" && installs.some((i) => Number(i.installation_id) === id);

  if (b.action === "git_branches") {
    const repoName = typeof b.repo === "string" ? b.repo : "";
    if (!mayUse(b.installation_id) || !/^[\w.-]+\/[\w.-]+$/.test(repoName)) return json({ error: "not_allowed" }, 403);
    const repo = await gh.repo(b.installation_id as number, repoName);
    const [branches, main] = await Promise.all([repo.branches(), repo.defaultBranch()]);
    return json({ branches, default: main });
  }

  if (!isUuid(b.game_id)) return json({ error: "bad_request" }, 400);
  const [g] = await w.db.select<{ id: string; created_by: string | null }>("games", `id=eq.${b.game_id}&select=id,created_by`);
  if (!g) return json({ error: "no_game" }, 404);
  if (g.created_by !== w.user.id && w.user.role !== "admin") return json({ error: "not_allowed" }, 403);

  if (b.action === "git_disconnect") {
    await w.db.remove("game_git", `game_id=eq.${g.id}`);
    return json({ ok: true });
  }

  let row: GitRow;
  if (b.action === "git_connect") {
    const repo = typeof b.repo === "string" ? b.repo.trim() : "";
    const branch = typeof b.branch === "string" ? b.branch.trim() : "";
    const folder = typeof b.folder === "string" ? b.folder.trim().replace(/^\.?\/+|\/+$/g, "") : "";
    if (!mayUse(b.installation_id)) return json({ error: "not_allowed" }, 403);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !BRANCH.test(branch) || folder.length > 200 || folder.split("/").includes("..")) return json({ error: "bad_request" }, 400);
    // The installation must really reach this repository, and the branch must exist.
    const repos = await gh.repos(b.installation_id as number);
    if (!repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return json({ error: "not_allowed" }, 403);
    const exact = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())!.repo;
    if (!(await (await gh.repo(b.installation_id as number, exact)).branches()).includes(branch)) return json({ error: "no_branch" }, 404);
    row = { game_id: g.id, installation_id: b.installation_id as number, repo: exact, branch, folder, created_by: w.user.id };
    await w.db.insert("game_git?on_conflict=game_id", { ...row, status: "waiting", error: null, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
  } else if (b.action === "git_deploy") {
    const [r] = await w.db.select<GitRow>("game_git", `game_id=eq.${g.id}&select=game_id,installation_id,repo,branch,folder,created_by`);
    if (!r) return json({ error: "no_repo" }, 404);
    row = r;
  } else return json({ error: "bad_request" }, 400);

  const { config } = await r2Config(w.db, w.serviceKey);
  if (!config) return json({ error: "hosting_off" }, 503);
  const out = await deployCommit(hostingDeps(w.db, config), gh, row);
  return json(out, out.ok ? 200 : 422);
}

/** For an app made before Toki listened to pushes: the secret set on GitHub for its webhook. */
async function setWebhookSecret(w: Who, b: Record<string, unknown>) {
  const secret = typeof b.secret === "string" ? b.secret.trim() : "";
  if (secret.length < 8 || secret.length > 200) return json({ error: "bad_request" }, 400);
  const { env, sources } = await withSecrets(w.db, { ...serverEnv(), serviceKey: w.serviceKey });
  if (sources.github !== "toki") return json({ error: sources.github === "env" ? "github_env" : "github_off" }, 409);
  await saveSecret(w.db, env, "github_app", JSON.stringify({ ...env.github, webhookSecret: secret }), w.user.id);
  return json({ ok: true });
}
