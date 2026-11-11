// What search engines and link previews get for Toki's public pages: title, description, image,
// structured data, a plain HTML version of the content, and the sitemap.
import { coverFor } from "../src/pixel/scenes.js";
import { esc, type PageMeta } from "./meta.js";

export const SITE_DESCRIPTION = "Free browser games. Play instantly, no account needed.";
const HOME_DESCRIPTION = "Play free browser games on Toki: instantly, on any device, no download and no account needed. Save your progress, beat high scores and play with friends.";

export interface SeoGame {
  slug: string;
  title: string;
  description: string;
  category?: string | null;
  thumbnail_url?: string | null;
  cover?: string | null;
  multiplayer?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** The columns the functions here need. */
export const SEO_GAME_COLUMNS = "slug,title,description,category,thumbnail_url,cover,multiplayer,created_at,updated_at";

const CATEGORY: Record<string, string> = {
  action: "Action", adventure: "Adventure", arcade: "Arcade", horror: "Horror", platformer: "Platformer",
  puzzle: "Puzzle", racing: "Racing", shooter: "Shooter", sports: "Sports", strategy: "Strategy", other: "Other",
};

const short = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const imageFor = (g: SeoGame, origin: string) =>
  g.thumbnail_url ?? `${origin}/api/og?slug=${encodeURIComponent(g.slug)}&cover=${coverFor(g.slug, g.cover ?? null)}`;

const footer = `<footer><a href="/updates">What's new on Toki</a> · <a href="/feedback">Feedback</a> · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a></footer>`;
const header = `<header><a href="/">Toki</a></header>`;

function website(origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Toki",
    url: `${origin}/`,
    description: HOME_DESCRIPTION,
    inLanguage: ["en", "de"],
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${origin}/?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export function homeMeta(games: SeoGame[], origin: string): PageMeta {
  const list = games
    .map((g) => `<li><a href="/game/${esc(g.slug)}">${esc(g.title)}</a>${g.description ? ` – ${esc(short(g.description))}` : ""}</li>`)
    .join("");
  return {
    title: "Toki: free browser games",
    description: HOME_DESCRIPTION,
    image: `${origin}/api/og?slug=toki&cover=orbit`,
    url: `${origin}/`,
    jsonLd: [
      website(origin),
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Free browser games on Toki",
        itemListElement: games.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: `${origin}/game/${g.slug}`, name: g.title })),
      },
    ],
    body: `${header}<main><h1>Toki: free browser games</h1><p>${esc(HOME_DESCRIPTION)}</p>${list ? `<h2>All games</h2><ul>${list}</ul>` : ""}</main>${footer}`,
  };
}

export type GameSubpage = "updates" | "feedback";

export function gameMeta(g: SeoGame, origin: string, sub?: GameSubpage): PageMeta {
  const url = `${origin}/game/${g.slug}${sub ? `/${sub}` : ""}`;
  const image = imageFor(g, origin);
  const crumbs = [
    { "@type": "ListItem", position: 1, name: "Toki", item: `${origin}/` },
    { "@type": "ListItem", position: 2, name: g.title, item: `${origin}/game/${g.slug}` },
    ...(sub ? [{ "@type": "ListItem", position: 3, name: sub === "updates" ? "Updates" : "Feedback", item: url }] : []),
  ];
  const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs };
  const genre = g.category ? CATEGORY[g.category] : undefined;
  const back = `<p><a href="/game/${esc(g.slug)}">Play ${esc(g.title)}</a></p>`;

  if (sub === "updates")
    return {
      title: `Updates for ${g.title} · Toki`,
      description: `What changed in each version of ${g.title}, a free browser game on Toki.`,
      image, url, jsonLd: [breadcrumb],
      body: `${header}<main><h1>Updates for ${esc(g.title)}</h1><p>What changed in each version of ${esc(g.title)}.</p>${back}</main>${footer}`,
    };
  if (sub === "feedback")
    return {
      title: `Feedback for ${g.title} · Toki`,
      description: `Bug reports and ideas for ${g.title}, a free browser game on Toki. Tell the developer what you think.`,
      image, url, jsonLd: [breadcrumb],
      body: `${header}<main><h1>Feedback for ${esc(g.title)}</h1><p>Bug reports and ideas for ${esc(g.title)}.</p>${back}</main>${footer}`,
    };

  const description = g.description || `Play ${g.title} on Toki. ${SITE_DESCRIPTION}`;
  const game = {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: g.title,
    description: short(description, 500),
    url,
    image,
    ...(genre ? { genre } : {}),
    gamePlatform: "Web browser",
    applicationCategory: "Game",
    operatingSystem: "Any",
    playMode: g.multiplayer ? ["SinglePlayer", "MultiPlayer"] : "SinglePlayer",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: 0, priceCurrency: "USD", availability: "https://schema.org/InStock" },
    ...(g.created_at ? { datePublished: g.created_at.slice(0, 10) } : {}),
    ...(g.updated_at ? { dateModified: g.updated_at.slice(0, 10) } : {}),
    publisher: { "@type": "Organization", name: "Toki", url: `${origin}/` },
  };
  return {
    title: `${g.title} · Toki`,
    description,
    image,
    url,
    jsonLd: [game, breadcrumb],
    body:
      `${header}<main><h1>${esc(g.title)}</h1>` +
      `<p>${genre ? `${esc(genre)} game. ` : ""}Play for free in your browser, no download needed.</p>` +
      (g.description ? `<p>${esc(g.description)}</p>` : "") +
      `<p><a href="/game/${esc(g.slug)}/updates">Updates</a> · <a href="/game/${esc(g.slug)}/feedback">Feedback</a> · <a href="/">More free games</a></p>` +
      `</main>${footer}`,
  };
}

const STATIC: Record<string, { title: string; description: string }> = {
  "/updates": { title: "What's new on Toki", description: "Release notes for Toki: new features and fixes for players and game developers." },
  "/feedback": { title: "Feedback for Toki", description: "Bug reports and ideas for Toki. Tell us what you'd like to see next and vote for other players' ideas." },
  "/terms": { title: "Terms of Service", description: "The rules for using Toki, the website for free browser games." },
  "/privacy": { title: "Privacy Policy", description: "What data Toki keeps, why, for how long, and who helps run Toki." },
};

/** Meta for Toki's own fixed pages, or null for other addresses. */
export function staticMeta(pathname: string, origin: string): PageMeta | null {
  const path = pathname.replace(/\/+$/, "");
  const page = STATIC[path];
  if (!page) return null;
  return {
    title: `${page.title} · Toki`,
    description: page.description,
    image: `${origin}/api/og?slug=toki&cover=orbit`,
    url: `${origin}${path}`,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Toki", item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: page.title, item: `${origin}${path}` },
        ],
      },
    ],
    body: `${header}<main><h1>${esc(page.title)}</h1><p>${esc(page.description)}</p></main>${footer}`,
  };
}

/** A page that isn't there, for crawlers: not found, and kept out of search results. */
export function missingMeta(url: string, origin: string): PageMeta {
  return {
    title: "Page not found · Toki",
    description: SITE_DESCRIPTION,
    image: `${origin}/api/og?slug=toki&cover=orbit`,
    url,
    noindex: true,
    body: `${header}<main><h1>Page not found.</h1><p><a href="/">Free browser games on Toki</a></p></main>${footer}`,
  };
}

/** The sitemap: Toki's public pages and every game. */
export function sitemapXml(games: SeoGame[], origin: string): string {
  const day = (s?: string | null) => (s ? s.slice(0, 10) : undefined);
  const newest = games.map((g) => day(g.updated_at)).filter(Boolean).sort().pop();
  const urls: { loc: string; lastmod?: string; priority: string }[] = [
    { loc: `${origin}/`, lastmod: newest, priority: "1.0" },
    ...games.map((g) => ({ loc: `${origin}/game/${g.slug}`, lastmod: day(g.updated_at), priority: "0.8" })),
    ...games.map((g) => ({ loc: `${origin}/game/${g.slug}/updates`, lastmod: day(g.updated_at), priority: "0.4" })),
    ...games.map((g) => ({ loc: `${origin}/game/${g.slug}/feedback`, priority: "0.3" })),
    { loc: `${origin}/updates`, priority: "0.5" },
    { loc: `${origin}/feedback`, priority: "0.4" },
    { loc: `${origin}/terms`, priority: "0.2" },
    { loc: `${origin}/privacy`, priority: "0.2" },
  ];
  const body = urls
    .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** /llms.txt: a short guide to Toki for AI search and AI agents, with every game. */
export function llmsTxt(games: SeoGame[], origin: string): string {
  const line = (g: SeoGame) => {
    const genre = g.category ? CATEGORY[g.category] : undefined;
    const about = [genre && `${genre} game`, g.multiplayer && "multiplayer", g.description && short(g.description, 200)].filter(Boolean).join(". ");
    return `- [${g.title.replace(/[[\]]/g, "")}](${origin}/game/${g.slug})${about ? `: ${about}` : ""}`;
  };
  return [
    "# Toki",
    "",
    `> Toki (${origin}) is a website for free browser games, in English and German. Players play instantly in the browser, on any device, without a download or an account. With a free account they keep their progress on every device, compete for high scores, add friends, chat and play together. Developers add their web games; each game has its own page, feedback board and release notes.`,
    "",
    "## Games",
    "",
    ...(games.length ? games.map(line) : ["- No games yet."]),
    "",
    "## Pages",
    "",
    `- [All games](${origin}/): the home page, with search and categories.`,
    `- [What's new on Toki](${origin}/updates): release notes for Toki.`,
    `- [Feedback](${origin}/feedback): bug reports and ideas for Toki.`,
    `- [Terms of Service](${origin}/terms)`,
    `- [Privacy Policy](${origin}/privacy)`,
    `- [Sitemap](${origin}/sitemap.xml)`,
    "",
    "## For AI agents",
    "",
    `- [Publishing a game on Toki](${origin}/agents.md): web builds, toki.json, the upload script, GitHub Actions and the upload API.`,
    `- [Upload script](${origin}/toki-upload.mjs): \`TOKI_KEY=toki_… node toki-upload.mjs <folder>\` (Node.js 18+).`,
    `- [Save script](${origin}/toki-save.js): saves and \`toki.score(points)\` for games that run elsewhere (hosted games get it automatically).`,
    "",
  ].join("\n");
}
