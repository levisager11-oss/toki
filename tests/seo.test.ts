import { describe, expect, it } from "vitest";
import { injectMeta, PREVIEW_BOT } from "../server/meta";
import { gameMeta, homeMeta, llmsTxt, missingMeta, sitemapXml, staticMeta, type SeoGame } from "../server/seo";

const O = "https://www.playtoki.app";
const html = `<html><head>\n<title>Toki</title>\n<meta name="description" content="old" />\n</head><body>\n<div id="root"></div>\n</body></html>`;
const game: SeoGame = { slug: "deep", title: "Deep </script>", description: "Dive deep.", category: "puzzle", thumbnail_url: null, cover: null, multiplayer: true, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-10T10:00:00Z" };

describe("game page meta", () => {
  const m = gameMeta(game, O);
  const out = injectMeta(html, m);
  it("has structured data that can't break out of its script tag", () => {
    const ld = [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((x) => JSON.parse(x[1]));
    expect(ld.map((d) => d["@type"])).toEqual(["VideoGame", "BreadcrumbList"]);
    expect(ld[0]).toMatchObject({ name: "Deep </script>", genre: "Puzzle", playMode: ["SinglePlayer", "MultiPlayer"], isAccessibleForFree: true });
    expect(out.match(/<\/script>/g)).toHaveLength(2);
  });
  it("puts a plain version of the page into the root, escaped", () => {
    expect(out).toContain('<div id="root"><header>');
    expect(out).toContain("<h1>Deep &lt;/script&gt;</h1>");
    expect(out).toContain('href="/game/deep/feedback"');
  });
  it("points the canonical at the page itself", () => {
    expect(out).toContain(`<link rel="canonical" href="${O}/game/deep" />`);
    expect(injectMeta(html, gameMeta(game, O, "updates"))).toContain(`<link rel="canonical" href="${O}/game/deep/updates" />`);
  });
});

describe("other pages", () => {
  it("lists every game on the home page", () => {
    const out = injectMeta(html, homeMeta([game], O));
    expect(out).toContain('<a href="/game/deep">');
    expect(out).toContain('"@type":"SearchAction"');
  });
  it("knows Toki's fixed pages", () => {
    expect(staticMeta("/terms/", O)?.url).toBe(`${O}/terms`);
    expect(staticMeta("/nope", O)).toBeNull();
  });
  it("keeps missing pages out of search results", () => {
    expect(injectMeta(html, missingMeta(`${O}/game/x`, O))).toContain(`<meta name="robots" content="noindex" />`);
  });
});

describe("sitemap and llms.txt", () => {
  it("lists the games with their last change", () => {
    const xml = sitemapXml([game], O);
    expect(xml).toContain(`<loc>${O}/game/deep</loc><lastmod>2026-11-10</lastmod>`);
    expect(xml).toContain(`<loc>${O}/privacy</loc>`);
  });
  it("describes every game for AI search", () => {
    expect(llmsTxt([game], O)).toContain(`- [Deep </script>](${O}/game/deep): Puzzle game. multiplayer. Dive deep.`);
  });
});

describe("PREVIEW_BOT", () => {
  it.each(["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "Claude-User/1.0", "Mozilla/5.0 (compatible; PerplexityBot/1.0)", "Mozilla/5.0 (compatible; Googlebot/2.1)"])(
    "matches %s",
    (ua) => expect(PREVIEW_BOT.test(ua)).toBe(true),
  );
});
