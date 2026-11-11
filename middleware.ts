// Link previews and search engines: chat apps and many crawlers don't run the site's JavaScript,
// so for them we fill in the page title, description, image, structured data and a plain
// version of the content on the server.
// Game pages of games that need cross-origin isolation get the isolation headers here.
// Everyone else passes straight through.
import { SUPABASE_KEY, SUPABASE_URL } from "./server/config.js";
import { gameSlug, ISOLATION_HEADERS, needsIsolation } from "./server/isolation.js";
import { injectMeta, PREVIEW_BOT, type PageMeta } from "./server/meta.js";
import { gameMeta, homeMeta, missingMeta, SEO_GAME_COLUMNS, staticMeta, type GameSubpage, type SeoGame } from "./server/seo.js";

export const config = { matcher: ["/", "/game/:slug*", "/updates", "/feedback", "/terms", "/privacy"] };

async function games(query: string): Promise<SeoGame[] | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games?${query}`, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) return null;
  return (await res.json()) as SeoGame[];
}

/** A game's page or one of its public subpages. undefined: not such an address. */
function gamePath(pathname: string): { slug: string; sub?: GameSubpage | "stats" } | undefined {
  const m = /^\/game\/([a-z0-9-]+)(?:\/(updates|feedback|stats))?\/?$/.exec(pathname);
  return m ? { slug: m[1], sub: m[2] as GameSubpage | "stats" | undefined } : undefined;
}

/** The meta for a page, null when the page isn't there, undefined to serve the normal page. */
async function metaFor(url: URL): Promise<PageMeta | null | undefined> {
  const { origin, pathname } = url;
  if (pathname === "/") {
    const list = await games(`select=${SEO_GAME_COLUMNS}&order=featured.desc,created_at.desc&limit=200`);
    return list ? homeMeta(list, origin) : undefined;
  }
  const page = staticMeta(pathname, origin);
  if (page) return page;
  const path = gamePath(pathname);
  if (!path) return undefined;
  // The current slug, or an old one of a renamed game.
  const s = encodeURIComponent(path.slug);
  const rows = await games(`or=(slug.eq.${s},old_slugs.cs.%7B${s}%7D)&select=${SEO_GAME_COLUMNS}`);
  if (!rows) return undefined;
  const g = rows.find((r) => r.slug === path.slug) ?? rows[0];
  if (!g) return null;
  if (path.sub === "stats") return { ...gameMeta(g, origin), url: `${origin}/game/${g.slug}/stats`, noindex: true, body: undefined };
  return gameMeta(g, origin, path.sub);
}

async function isolatedPage(request: Request, url: URL): Promise<Response | undefined> {
  const slug = gameSlug(url.pathname);
  if (!slug || !(await needsIsolation(slug))) return;
  const page = await fetch(new URL("/index.html", url), { headers: { cookie: request.headers.get("cookie") ?? "" } });
  if (!page.ok) return;
  return new Response(page.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...ISOLATION_HEADERS,
    },
  });
}

export default async function middleware(request: Request) {
  const url = new URL(request.url);
  // "?og" shows what preview bots get, for testing in a normal browser.
  if (!PREVIEW_BOT.test(request.headers.get("user-agent") ?? "") && !url.searchParams.has("og")) {
    try {
      return await isolatedPage(request, url);
    } catch {
      return; // on any problem, serve the normal page
    }
  }
  try {
    const meta = await metaFor(url);
    if (meta === undefined) return;
    const page = await fetch(new URL("/index.html", url), { headers: { cookie: request.headers.get("cookie") ?? "" } });
    if (!page.ok) return;
    const html = injectMeta(await page.text(), meta ?? missingMeta(url.href, url.origin));
    return new Response(html, {
      status: meta ? 200 : 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=300" },
    });
  } catch {
    return; // on any problem, serve the normal page
  }
}
