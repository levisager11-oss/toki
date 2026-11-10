// Uploads from GitHub Actions without a key. Each Actions run can ask GitHub for a short-lived
// token, signed by GitHub, that says which repository, branch and commit it runs for (OpenID
// Connect, "id-token: write" in the workflow). Toki checks GitHub's signature and accepts the
// upload only for the game that follows exactly that repository and branch and is built by
// GitHub Actions (game_git.build = 'action', see 20261120090000_github_build.sql). Forks and pull
// requests can't pretend: their token names the fork, or a pull request instead of the branch.
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { Db } from "./db.js";
import type { HostUser } from "./hosting.js";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
/** The audience the upload script asks GitHub for: the token is only good for Toki. */
export const ACTIONS_AUDIENCE = "toki-upload";

export interface ActionClaims {
  /** owner/name */
  repository: string;
  /** refs/heads/<branch> */
  ref: string;
  sha: string;
  event_name?: string;
}

export class ActionsAuthError extends Error {}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Whether a Bearer token looks like a signed token (three parts, the first one JSON). */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    return typeof JSON.parse(b64(parts[0]).toString("utf8")) === "object";
  } catch {
    return false;
  }
}

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };
let cache: { at: number; jwks: Jwks } | null = null;
async function keys(fetchImpl: typeof fetch, fresh: boolean): Promise<Jwks> {
  if (cache && !fresh && Date.now() - cache.at < 3600_000) return cache.jwks;
  const res = await fetchImpl(`${ACTIONS_ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ActionsAuthError(`GitHub keys: ${res.status}`);
  cache = { at: Date.now(), jwks: (await res.json()) as Jwks };
  return cache.jwks;
}

/** Checks a GitHub Actions token: GitHub's signature, for Toki, not expired. Returns what it says. */
export async function verifyActionToken(token: string, o: { fetch?: typeof fetch; now?: number; jwks?: Jwks } = {}): Promise<ActionClaims> {
  const [h, p, s] = token.split(".");
  let head: { alg?: string; kid?: string };
  let body: Record<string, unknown>;
  try {
    head = JSON.parse(b64(h).toString("utf8"));
    body = JSON.parse(b64(p).toString("utf8"));
  } catch {
    throw new ActionsAuthError("not a token");
  }
  if (head.alg !== "RS256" || !head.kid) throw new ActionsAuthError("unexpected signature");
  const find = (j: Jwks) => j.keys.find((k) => k.kid === head.kid);
  let jwk = o.jwks ? find(o.jwks) : find(await keys(o.fetch ?? fetch, false));
  // GitHub turns its keys over now and then: look again once.
  if (!jwk && !o.jwks) jwk = find(await keys(o.fetch ?? fetch, true));
  if (!jwk) throw new ActionsAuthError("unknown key");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), b64(s));
  if (!ok) throw new ActionsAuthError("bad signature");

  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (body.iss !== ACTIONS_ISSUER) throw new ActionsAuthError("not from GitHub Actions");
  if (!aud.includes(ACTIONS_AUDIENCE)) throw new ActionsAuthError("not meant for Toki");
  if (typeof body.exp !== "number" || body.exp < now - 30) throw new ActionsAuthError("expired");
  if (typeof body.nbf === "number" && body.nbf > now + 60) throw new ActionsAuthError("not valid yet");
  const repository = typeof body.repository === "string" ? body.repository : "";
  const ref = typeof body.ref === "string" ? body.ref : "";
  const sha = typeof body.sha === "string" ? body.sha : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !ref || !/^[0-9a-f]{40}$/.test(sha)) throw new ActionsAuthError("incomplete token");
  return { repository, ref, sha, event_name: typeof body.event_name === "string" ? body.event_name : undefined };
}

export interface ActionGame {
  game_id: string;
  user: HostUser & { username: string };
}

/**
 * The game an Actions run may upload to: the one that follows its repository and branch and is
 * built by GitHub Actions, uploading as the game's developer (who must still be a developer).
 * null when there's none.
 */
export async function gameForAction(db: Db, c: ActionClaims): Promise<ActionGame | null> {
  if (!c.ref.startsWith("refs/heads/")) return null;
  const branch = c.ref.slice("refs/heads/".length);
  const rows = await db.select<{ game_id: string; repo: string }>(
    "game_git",
    `branch=eq.${encodeURIComponent(branch)}&build=eq.action&repo=ilike.${encodeURIComponent(c.repository.replace(/[%_*]/g, ""))}&select=game_id,repo`,
  );
  const row = rows.find((r) => r.repo.toLowerCase() === c.repository.toLowerCase());
  if (!row) return null;
  const [g] = await db.select<{ created_by: string | null }>("games", `id=eq.${row.game_id}&select=created_by`);
  if (!g?.created_by) return null;
  const [p] = await db.select<ActionGame["user"]>("profiles", `id=eq.${g.created_by}&select=id,username,role`);
  if (!p || p.role === "player") return null;
  return { game_id: row.game_id, user: p };
}
