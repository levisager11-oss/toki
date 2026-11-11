// The sitemap for search engines: Toki's public pages and every game (/sitemap.xml).
import { SUPABASE_KEY, SUPABASE_URL } from "../server/config.js";
import { SEO_GAME_COLUMNS, sitemapXml, type SeoGame } from "../server/seo.js";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  let games: SeoGame[] = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/games?select=${SEO_GAME_COLUMNS}&order=created_at.desc&limit=5000`, { headers: { apikey: SUPABASE_KEY } });
    if (res.ok) games = (await res.json()) as SeoGame[];
  } catch {
    /* the fixed pages still go out */
  }
  return new Response(sitemapXml(games, origin), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600, s-maxage=3600" },
  });
}
