// Cross-origin isolation (needed for SharedArrayBuffer, e.g. Godot 4 exports with threads).
// Only game pages whose game has "needs isolation" on get these headers: with them, the browser
// only shows games whose own site sends matching headers, which most games don't.
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

const CACHE_MS = 60_000;
const cache = new Map<string, { on: boolean; at: number }>();

/** The game's slug for a game page address, or undefined. */
export function gameSlug(pathname: string): string | undefined {
  return /^\/game\/([a-z0-9-]+)\/?$/.exec(pathname)?.[1];
}

/** Whether this game's page needs the isolation headers. false when unsure, so games still load. */
export async function needsIsolation(slug: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.on;
  try {
    const q = `slug=eq.${encodeURIComponent(slug)}&select=needs_isolation`;
    const res = await fetchImpl(`${SUPABASE_URL}/rest/v1/games?${q}`, { headers: { apikey: SUPABASE_KEY }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const [g] = (await res.json()) as { needs_isolation?: boolean }[];
    const on = g?.needs_isolation === true;
    cache.set(slug, { on, at: Date.now() });
    return on;
  } catch {
    return false;
  }
}
