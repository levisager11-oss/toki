// Link previews: chat apps don't run the site's JavaScript, so for them we fill in the
// page title, description and image on the server.
// Game pages of games that need cross-origin isolation get the isolation headers here.
// Everyone else passes straight through.
import { coverFor } from "./src/pixel/scenes.js";
import { SUPABASE_KEY, SUPABASE_URL } from "./server/config.js";
import { gameSlug, ISOLATION_HEADERS, needsIsolation } from "./server/isolation.js";
import { injectMeta, PREVIEW_BOT, type PageMeta } from "./server/meta.js";

export const config = { matcher: ["/", "/game/:slug*"] };

const SITE_DESCRIPTION = "Browser games made by friends. Play free, no account needed.";

async function gameMeta(slug: string, origin: string): Promise<PageMeta | null> {
  const q = `slug=eq.${encodeURIComponent(slug)}&select=slug,title,description,thumbnail_url,cover`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games?${q}`, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) return null;
  const [g] = (await res.json()) as { slug: string; title: string; description: string; thumbnail_url: string | null; cover: string | null }[];
  if (!g) return null;
  return {
    title: `${g.title} · Toki`,
    description: g.description || `Play ${g.title} on Toki. ${SITE_DESCRIPTION}`,
    image: g.thumbnail_url ?? `${origin}/api/og?slug=${encodeURIComponent(g.slug)}&cover=${coverFor(g.slug, g.cover)}`,
    url: `${origin}/game/${g.slug}`,
  };
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
    const slug = gameSlug(url.pathname);
    const meta = slug
      ? await gameMeta(slug, url.origin)
      : { title: "Toki", description: SITE_DESCRIPTION, image: `${url.origin}/api/og?slug=toki&cover=orbit`, url: `${url.origin}/` };
    if (!meta) return;
    const page = await fetch(new URL("/index.html", url), { headers: { cookie: request.headers.get("cookie") ?? "" } });
    if (!page.ok) return;
    return new Response(injectMeta(await page.text(), meta), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=300" },
    });
  } catch {
    return; // on any problem, serve the normal page
  }
}
