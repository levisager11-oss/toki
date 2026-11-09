// For members adding a game: can this link be shown inside Toki?
import { SUPABASE_KEY, SUPABASE_URL } from "../server/config.js";
import { checkHeaders, isCheckableUrl, type EmbedCheck } from "../server/embed-check.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function isMember(auth: string | null) {
  if (!auth?.startsWith("Bearer ")) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: auth } });
  return res.ok;
}

/** Follows up to 5 redirects, each only to a public https site (never to local or private addresses). */
async function fetchChecked(url: string): Promise<Response | null> {
  const signal = AbortSignal.timeout(8000);
  for (let hops = 0; hops <= 5; hops++) {
    if (!isCheckableUrl(url)) return null;
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "TokiLinkCheck/1.0" }, signal });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    await res.body?.cancel();
    url = new URL(next, url).toString();
  }
  return null;
}

export async function GET(request: Request) {
  if (!(await isMember(request.headers.get("authorization")))) return json({ error: "login required" }, 401);
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!isCheckableUrl(target)) return json({ error: "bad url" }, 400);
  const origin = new URL(request.url).origin;
  try {
    const res = await fetchChecked(target);
    if (!res) return json({ reachable: false, status: 0, framable: false, isolation: false } satisfies EmbedCheck);
    await res.body?.cancel();
    const result: EmbedCheck = { reachable: res.ok, status: res.status, ...checkHeaders(res.headers, origin) };
    return json(result);
  } catch {
    return json({ reachable: false, status: 0, framable: false, isolation: false } satisfies EmbedCheck);
  }
}
