// Puts a page's title, description and preview image into index.html for link previews and
// search engines. Crawlers also get structured data and a plain version of the page's content.
export interface PageMeta {
  title: string;
  description: string;
  image: string;
  url: string;
  /** Structured data (schema.org) for search engines. */
  jsonLd?: object[];
  /** Keep the page out of search results. */
  noindex?: boolean;
  /** Plain HTML for crawlers that don't run JavaScript. The app replaces it as soon as it starts. */
  body?: string;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON that is safe inside a <script> tag. */
const scriptJson = (v: object) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export function injectMeta(html: string, m: PageMeta): string {
  const description = m.description.replace(/\s+/g, " ").trim().slice(0, 200);
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Toki" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(m.url)}" />`,
    `<meta property="og:image" content="${esc(m.image)}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:locale:alternate" content="de_DE" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(m.title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(m.image)}" />`,
    `<link rel="canonical" href="${esc(m.url)}" />`,
    ...(m.noindex ? [`<meta name="robots" content="noindex" />`] : []),
    ...(m.jsonLd ?? []).map((d) => `<script type="application/ld+json">${scriptJson(d)}</script>`),
  ].join("\n    ");
  // Replacement functions, not strings: a "$" in a game's title must stay a "$".
  let out = html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, () => `<meta name="description" content="${esc(description)}" />`)
    .replace(/\s*<meta (property="og:|name="twitter:)[^>]*>/g, "")
    .replace(/\s*<link rel="canonical"[^>]*>/g, "")
    .replace(/\s*<meta name="robots"[^>]*>/g, "")
    .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")
    .replace("</head>", () => `    ${tags}\n  </head>`);
  if (m.body) out = out.replace('<div id="root"></div>', () => `<div id="root">${m.body}</div>`);
  return out;
}

/**
 * Chat apps, search engines and AI search (ChatGPT, Claude, Perplexity, …) that read link
 * previews or the page's content. Normal browsers don't match.
 */
export const PREVIEW_BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|discord|slack|telegram|signal|skype|preview|embedly|pinterest|vkshare|mastodon|bluesky|iframely|chatgpt-user|claude-user|perplexity-user|mistralai-user|meta-externalagent|meta-externalfetcher|google-extended|cohere-ai|ai2bot|diffbot/i;
