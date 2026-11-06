// Puts a page's title, description and preview image into index.html for link previews.
export interface PageMeta {
  title: string;
  description: string;
  image: string;
  url: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function injectMeta(html: string, m: PageMeta): string {
  const description = m.description.replace(/\s+/g, " ").trim().slice(0, 200);
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Toki" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(m.url)}" />`,
    `<meta property="og:image" content="${esc(m.image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<link rel="canonical" href="${esc(m.url)}" />`,
  ].join("\n    ");
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
    .replace(/\s*<meta (property="og:|name="twitter:)[^>]*>/g, "")
    .replace(/\s*<link rel="canonical"[^>]*>/g, "")
    .replace("</head>", `    ${tags}\n  </head>`);
}

/** Chat apps and search engines that read link previews. Normal browsers don't match. */
export const PREVIEW_BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|discord|slack|telegram|signal|skype|preview|embedly|pinterest|vkshare|mastodon|bluesky|iframely/i;
