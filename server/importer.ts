// "Fill in from a link": what Toki can learn about a game from its itch.io page, its GitHub
// repository, or any page it runs on, so developers don't type it all themselves.
// Only reads public pages (server/assist/pages.ts keeps it away from private addresses).
import { fetchText } from "./assist/pages.js";
import type { Category } from "../src/lib/types.js";
import { readTokiJson, type TokiJson } from "../src/lib/hostingRules.js";

export interface Imported {
  source: "itch" | "github" | "page";
  title: string;
  description: string;
  play_url: string | null;
  thumbnail_url: string | null;
  screenshots: string[];
  category: Category | null;
  engine: string | null;
  controls: string;
  isolation: boolean | null;
  /** GitHub: owner/repo, to offer syncing */
  repo: string | null;
  /** What the game's toki.json said, if it has one */
  toki: TokiJson | null;
}

type Fetch = (url: string, opts?: { accept?: string; max?: number }) => Promise<{ url: string; text: string } | null>;

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

export function meta(html: string, name: string): string {
  const v =
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html)?.[1] ??
    "";
  return decode(v).replace(/\s+/g, " ").trim();
}

const httpsOnly = (u: string | null | undefined, base?: string): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u, base);
    return url.protocol === "https:" && url.href.length <= 500 ? url.href : null;
  } catch {
    return null;
  }
};

/** A good guess at the engine from the page's code. */
export function guessEngine(html: string): string | null {
  if (/createUnityInstance|UnityLoader|\.unityweb|unity-container/i.test(html)) return "Unity";
  if (/godot|\.pck["']|engine\.startGame/i.test(html)) return "Godot";
  if (/phaser/i.test(html)) return "Phaser";
  if (/c3runtime|construct\s?3|c2runtime/i.test(html)) return "Construct";
  if (/gamemaker|gml_|yoyogames/i.test(html)) return "GameMaker";
  if (/pico-?8|pico8/i.test(html)) return "PICO-8";
  if (/rpg\s?maker|rpg_core|rmmz_/i.test(html)) return "RPG Maker";
  if (/three(\.module)?(\.min)?\.js|THREE\./.test(html)) return "Three.js";
  if (/pixi(\.min)?\.js|PIXI\./.test(html)) return "PixiJS";
  if (/defold|dmloader/i.test(html)) return "Defold";
  if (/love\.js|love\.wasm/i.test(html)) return "LÖVE";
  if (/scratch|turbowarp/i.test(html)) return "Scratch";
  return null;
}

const CATEGORY_WORDS: [RegExp, Category][] = [
  [/platform/i, "platformer"], [/puzzle/i, "puzzle"], [/horror/i, "horror"], [/racing|driving/i, "racing"], [/shoot/i, "shooter"],
  [/sport/i, "sports"], [/strategy|tower defen[cs]e/i, "strategy"], [/adventure|role.?playing|rpg|visual novel/i, "adventure"],
  [/action|fighting/i, "action"], [/arcade|casual|card|rhythm/i, "arcade"],
];
export function guessCategory(text: string): Category | null {
  for (const [re, c] of CATEGORY_WORDS) if (re.test(text)) return c;
  return null;
}

const empty = (source: Imported["source"]): Imported => ({
  source, title: "", description: "", play_url: null, thumbnail_url: null, screenshots: [], category: null, engine: null, controls: "", isolation: null, repo: null, toki: null,
});

function withToki(out: Imported, toki: TokiJson | null): Imported {
  if (!toki || !Object.keys(toki).length) return out;
  return {
    ...out,
    toki,
    title: toki.title ?? out.title,
    description: toki.description ?? out.description,
    category: toki.category ?? out.category,
    engine: toki.engine ?? out.engine,
    controls: toki.controls ?? out.controls,
    isolation: toki.isolation ?? out.isolation,
  };
}

// ---------- itch.io ----------

export function readItch(html: string, pageUrl: string): Imported | { error: "not_web" } {
  const out = empty("itch");
  out.title = meta(html, "og:title").replace(/\s+by\s+[^]+$/i, "").slice(0, 60) || decode(/<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? "").split(" by ")[0].trim().slice(0, 60);
  out.description = (meta(html, "og:description") || meta(html, "description")).slice(0, 1000);
  out.thumbnail_url = httpsOnly(meta(html, "og:image"));
  out.screenshots = [...html.matchAll(/class=["'][^"']*screenshot[^"']*["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*class=["'][^"']*screenshot/gi)]
    .map((m) => httpsOnly(decode(m[1] ?? m[2]), pageUrl))
    .filter((u): u is string => !!u)
    .filter((u, i, all) => all.indexOf(u) === i)
    .slice(0, 4);
  // The game frame: in data-iframe="…" (click to play) or a real <iframe> (plays in the page).
  const frame = /https:\/\/(?:html-classic|html|v6p9d9t4)\.itch\.zone\/html\/\d+\/[^"'\s<>]*/i.exec(decode(html))?.[0];
  if (!frame) return { error: "not_web" };
  out.play_url = frame.replace(/&amp;/g, "&");
  const genre = /<td[^>]*>\s*Genre\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html)?.[1] ?? "";
  const tags = /<td[^>]*>\s*Tags\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html)?.[1] ?? "";
  out.category = guessCategory(decode(genre.replace(/<[^>]+>/g, " "))) ?? guessCategory(decode(tags.replace(/<[^>]+>/g, " ")));
  const madeWith = /<td[^>]*>\s*Made with\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html)?.[1];
  const engine = madeWith && decode(madeWith.replace(/<[^>]+>/g, " ")).split(",")[0].replace(/\s+/g, " ").trim();
  out.engine = engine ? engine.slice(0, 30) : null;
  // itch.io turns on SharedArrayBuffer support for games that need it (Godot 4 with threads).
  out.isolation = /SharedArrayBuffer/i.test(html) ? true : null;
  return out;
}

// ---------- GitHub ----------

interface Repo {
  name: string;
  full_name: string;
  description: string | null;
  homepage: string | null;
  has_pages: boolean;
  owner: { login: string };
  topics?: string[];
  language: string | null;
}

export async function readGitHub(owner: string, name: string, get: Fetch): Promise<Imported | { error: "not_found" }> {
  const res = await get(`https://api.github.com/repos/${owner}/${name}`, { accept: "application/vnd.github+json" });
  let repo: Repo;
  try {
    repo = JSON.parse(res?.text ?? "") as Repo;
  } catch {
    return { error: "not_found" };
  }
  if (!repo?.full_name) return { error: "not_found" };
  const out = empty("github");
  out.repo = repo.full_name;
  out.title = repo.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
  out.description = (repo.description ?? "").slice(0, 1000);
  const login = repo.owner.login.toLowerCase();
  const pages = repo.name.toLowerCase() === `${login}.github.io` ? `https://${login}.github.io/` : `https://${login}.github.io/${repo.name}/`;
  out.play_url = httpsOnly(repo.homepage) ?? (repo.has_pages ? pages : null);
  const topics = (repo.topics ?? []).join(" ");
  out.engine = guessEngine(topics) ?? (repo.language === "GDScript" ? "Godot" : null);
  out.category = guessCategory(topics);
  const raw = await get(`https://raw.githubusercontent.com/${repo.full_name}/HEAD/toki.json`, { accept: "application/json", max: 20_000 });
  return withToki(out, raw ? readTokiJson(raw.text) : null);
}

// ---------- any page ----------

export async function readAnyPage(url: string, get: Fetch): Promise<Imported | { error: "unreachable" }> {
  const page = await get(url, { max: 400_000 });
  if (!page) return { error: "unreachable" };
  const html = page.text;
  const out = empty("page");
  out.title = (meta(html, "og:title") || decode(/<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? "")).replace(/\s+/g, " ").trim().slice(0, 60);
  out.description = (meta(html, "og:description") || meta(html, "description")).slice(0, 1000);
  out.thumbnail_url = httpsOnly(meta(html, "og:image"), url);
  out.play_url = url;
  out.engine = guessEngine(html);
  out.category = guessCategory(`${meta(html, "keywords")} ${out.title}`);
  const toki = await get(new URL("toki.json", url).href, { accept: "application/json", max: 20_000 });
  return withToki(out, toki && /^\s*\{/.test(toki.text) ? readTokiJson(toki.text) : null);
}

export type ImportError = "bad_url" | "not_web" | "not_found" | "unreachable";

export async function importGame(raw: string, get: Fetch = (u, o) => fetchText(u, o)): Promise<Imported | { error: ImportError }> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "bad_url" };
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return { error: "bad_url" };
  const host = url.hostname.toLowerCase();

  const gh = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})/.exec(url.pathname);
  if (host === "github.com" && gh) return readGitHub(gh[1], gh[2].replace(/\.git$/, ""), get);

  if (host.endsWith(".itch.io") && url.pathname.length > 1) {
    const page = await get(url.href, { max: 800_000 });
    if (!page) return { error: "unreachable" };
    return readItch(page.text, url.href);
  }

  return readAnyPage(url.href, get);
}

