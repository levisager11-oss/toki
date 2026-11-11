// /llms.txt: what Toki is and every game on it, for AI search and AI agents.
import { SUPABASE_KEY, SUPABASE_URL } from "../server/config.js";
import { llmsTxt, SEO_GAME_COLUMNS, type SeoGame } from "../server/seo.js";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  let games: SeoGame[] = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/games?select=${SEO_GAME_COLUMNS}&order=featured.desc,created_at.desc&limit=1000`, { headers: { apikey: SUPABASE_KEY } });
    if (res.ok) games = (await res.json()) as SeoGame[];
  } catch {
    /* the rest of the guide still goes out */
  }
  return new Response(llmsTxt(games, origin), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600, s-maxage=3600" },
  });
}
