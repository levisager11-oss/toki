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

export async function GET(request: Request) {
  if (!(await isMember(request.headers.get("authorization")))) return json({ error: "login required" }, 401);
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!isCheckableUrl(target)) return json({ error: "bad url" }, 400);
  const origin = new URL(request.url).origin;
  try {
    const res = await fetch(target, { redirect: "follow", headers: { "user-agent": "TokiLinkCheck/1.0" }, signal: AbortSignal.timeout(8000) });
    await res.body?.cancel();
    const result: EmbedCheck = { reachable: res.ok, status: res.status, ...checkHeaders(res.headers, origin) };
    return json(result);
  } catch {
    return json({ reachable: false, status: 0, framable: false, isolation: false } satisfies EmbedCheck);
  }
}
