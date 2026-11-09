// Shared parts of the AI and GitHub endpoints: answers, and who is asking.
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";
import { serviceDb, type Db } from "./db.js";
import { serverEnv, type ServerEnv } from "./env.js";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export type Role = "admin" | "creator" | "player";
export interface Ctx {
  env: ServerEnv;
  db: Db;
  user: { id: string; username: string; role: Role };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The logged-in account behind the request, if it has one of these roles; otherwise the error answer. */
export async function context(request: Request, roles: Role[], fetchImpl: typeof fetch = fetch): Promise<Ctx | Response> {
  const env = serverEnv();
  if (!env.serviceKey) return json({ error: "not_configured" }, 503);
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return json({ error: "login_required" }, 401);
  const res = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: auth } });
  if (!res.ok) return json({ error: "login_required" }, 401);
  const u = (await res.json()) as { id?: string };
  if (!isUuid(u.id)) return json({ error: "login_required" }, 401);
  const db = serviceDb(env.serviceKey, fetchImpl);
  const [profile] = await db.select<Ctx["user"]>("profiles", `id=eq.${u.id}&select=id,username,role`);
  if (!profile || !roles.includes(profile.role)) return json({ error: "not_allowed" }, 403);
  return { env, db, user: profile };
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
