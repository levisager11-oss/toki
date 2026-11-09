// The database with full rights (the service role), for server code only. Row level security
// does not apply here, so every caller checks who may do what itself.
import { SUPABASE_URL } from "./config.js";

export class DbError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function serviceDb(key: string, fetchImpl: typeof fetch = fetch) {
  // New secret keys go in the apikey header only; the older service_role key is a JWT and also
  // goes in Authorization.
  const auth: Record<string, string> = key.startsWith("sb_") ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };

  async function call<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { ...auth, "content-type": "application/json" };
    if (init.prefer) headers.prefer = init.prefer;
    const res = await fetchImpl(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new DbError(body?.message ?? res.statusText, res.status, body?.code);
    return body as T;
  }

  return {
    rpc: <T>(fn: string, args: Record<string, unknown>) => call<T>(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }),
    select: <T>(table: string, query: string) => call<T[]>(`${table}?${query}`),
    insert: <T>(table: string, row: Record<string, unknown> | Record<string, unknown>[], prefer = "return=representation") =>
      call<T[]>(table, { method: "POST", body: JSON.stringify(row), prefer }),
    update: <T>(table: string, query: string, patch: Record<string, unknown>) =>
      call<T[]>(`${table}?${query}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" }),
    remove: (table: string, query: string) => call<null>(`${table}?${query}`, { method: "DELETE" }),
  };
}

export type Db = ReturnType<typeof serviceDb>;
