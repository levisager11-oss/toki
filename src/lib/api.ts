// Calls to Toki's own server (api/), as the logged-in player. Small on purpose: the first
// download needs it, the rest of ./ai only the pages for developers and admins.
import { supabase } from "./supabase";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${data.session?.access_token ?? ""}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof body?.error === "string" ? body.error : "error", typeof body?.message === "string" ? body.message : "");
  return body as T;
}

export class ApiError extends Error {
  /** The server's explanation, when it gave one (e.g. what the AI endpoint answered). */
  constructor(code: string, readonly detail = "") {
    super(code);
  }
}
