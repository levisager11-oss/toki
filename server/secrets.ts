// The AI key and the GitHub App's credentials, set up by an admin on Toki (see
// supabase/migrations/20261110180000_server_secrets.sql). Stored encrypted with a key derived
// from the Supabase secret key, so the database alone never reveals them. Environment variables
// in Vercel, when set, win over what is stored here.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { githubConfigured, type ServerEnv } from "./env.js";

const VERSION = "v1";

function keyFrom(serviceKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", serviceKey, "toki.server_secrets", VERSION, 32));
}

export function encrypt(plain: string, serviceKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(serviceKey), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

/** null when it can't be read (e.g. the Supabase secret key was changed since). */
export function decrypt(stored: string, serviceKey: string): string | null {
  try {
    const [version, b64] = stored.split(":");
    if (version !== VERSION || !b64) return null;
    const raw = Buffer.from(b64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(serviceKey), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export type SecretName = "anthropic_api_key" | "github_app" | "cloudflare_r2";

export async function saveSecret(db: Db, env: ServerEnv, name: SecretName, plain: string, by: string): Promise<void> {
  await db.insert(
    "server_secrets?on_conflict=name",
    { name, value: encrypt(plain, env.serviceKey), updated_at: new Date().toISOString(), updated_by: by },
    "resolution=merge-duplicates,return=minimal",
  );
}

export async function removeSecret(db: Db, name: SecretName): Promise<void> {
  await db.remove("server_secrets", `name=eq.${name}`);
}

export interface Sources {
  anthropicKey: "env" | "toki" | null;
  github: "env" | "toki" | null;
}

/** The environment with stored secrets filled in where Vercel has none, and where each came from. */
export async function withSecrets(db: Db, env: ServerEnv): Promise<{ env: ServerEnv; sources: Sources }> {
  const sources: Sources = {
    anthropicKey: env.anthropicKey ? "env" : null,
    github: githubConfigured(env.github) ? "env" : null,
  };
  if (sources.anthropicKey && sources.github) return { env, sources };
  const rows = await db.select<{ name: SecretName; value: string }>("server_secrets", "select=name,value");
  const next: ServerEnv = { ...env, github: { ...env.github } };
  for (const r of rows) {
    const plain = decrypt(r.value, env.serviceKey);
    if (plain === null) continue;
    if (r.name === "anthropic_api_key" && !sources.anthropicKey) {
      next.anthropicKey = plain;
      sources.anthropicKey = "toki";
    }
    if (r.name === "github_app" && !sources.github) {
      try {
        const g = JSON.parse(plain) as ServerEnv["github"];
        if (githubConfigured(g)) {
          next.github = g;
          sources.github = "toki";
        }
      } catch {
        /* unreadable: treated as not set up */
      }
    }
  }
  return { env: next, sources };
}

export { githubManifest } from "../src/lib/githubManifest.js";

/** After an admin created the app on GitHub: GitHub hands over its credentials once for the code. */
export async function githubFromManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<ServerEnv["github"] & { htmlUrl: string }> {
  const res = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Toki-Connect" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: number; slug?: string; client_id?: string; client_secret?: string; pem?: string; html_url?: string; webhook_secret?: string | null; message?: string;
  };
  if (!res.ok || !body.id || !body.slug || !body.client_id || !body.client_secret || !body.pem) {
    throw new Error(`GitHub ${res.status}: ${body.message ?? "no app credentials"}`);
  }
  return {
    appId: String(body.id),
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret ?? "",
    htmlUrl: body.html_url ?? `https://github.com/apps/${body.slug}`,
  };
}
