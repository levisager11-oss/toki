// Link previews: chat apps don't run the site's JavaScript, so for them we fill in the
// page title, description and image on the server. Normal visitors pass straight through.
import { coverFor } from "./src/pixel/scenes.js";
import { SUPABASE_KEY, SUPABASE_URL } from "./server/config.js";
import { injectMeta, PREVIEW_BOT, type PageMeta } from "./server/meta.js";

export const config = { matcher: ["/", "/game/:slug*"] };

const SITE_DESCRIPTION = "Browser games by Levi and friends. Play free, no account needed.";

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

export default async function middleware(request: Request) {
  const url = new URL(request.url);
  // "?og" shows what preview bots get, for testing in a normal browser.
  if (!PREVIEW_BOT.test(request.headers.get("user-agent") ?? "") && !url.searchParams.has("og")) return;
  try {
    const slug = /^\/game\/([a-z0-9-]+)\/?$/.exec(url.pathname)?.[1];
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
