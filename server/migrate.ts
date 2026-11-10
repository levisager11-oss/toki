// "Move to Toki": a game that runs somewhere else (its own site, GitHub Pages, itch.io, …) moves
// onto Toki. The server downloads the game from its address, starting at its page: everything the
// page, its scripts and its styles point to inside the game's folder. The files then go live
// through the same steps as any upload (server/hosting.ts), and the game keeps its page, plays,
// likes, saves and high scores. Links to other sites (a font from a CDN, an ad script) stay as
// they are. Only public https sites are read, never local or private addresses.
//
// Players' progress: a game keeps it in the browser, under its address, and the new address
// can't read it. A game with Toki's save script hands it to Toki, so Toki carries it over by
// itself (src/lib/movedSaves.ts picks it up at the old address the first time a player opens the
// moved game). So a game moves only once it has the save script, unless the developer says to
// move anyway (and the progress stays behind).
import { lookup } from "node:dns/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { isCheckableUrl } from "./embed-check.js";
import { privateAddress, type Lookup } from "./assist/pages.js";
import { finishUpload, HostingError, startUpload, type Deps, type HostUser } from "./hosting.js";
import { cleanPath, MAX_GAME_BYTES, MAX_GAME_FILES, readTokiJson, type TokiJson } from "../src/lib/hostingRules.js";

/** The whole download may take this long (Vercel stops the request at 300 s). */
export const CRAWL_MS = 200_000;
/** Addresses tried at most (most guesses don't exist, and each costs a request). */
export const MAX_TRIES = 2500;
/** Text files read for more files (scripts, pages, styles) up to this size. */
const SCAN_BYTES = 12 * 1024 * 1024;

export interface CrawledFile {
  path: string;
  data: Uint8Array;
}
export interface Crawled {
  /** The game's page, with its query string and #part removed */
  start: string;
  entry: string;
  files: CrawledFile[];
  bytes: number;
  toki: TokiJson;
  /** The game has Toki's save script, so players' progress can come along */
  saveScript: boolean;
}

/** Toki's save script in a page or script of the game (linked, or copied in). */
export const SAVE_SCRIPT = /toki-save(\.min)?\.js|__tokiSave/;

export interface CrawlOptions {
  fetch?: typeof fetch;
  resolve?: Lookup;
  now?: () => number;
  deadline?: number;
  maxTries?: number;
}

const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

// Files a game loads by name. Strings ending in one of these are tried as files of the game.
const EXT = "html?|m?js|css|json|wasm|pck|data|unityweb|bin|mem|symbols|png|jpe?g|gif|webp|avif|svg|ico|bmp|ktx2?|basis|dds|mp3|ogg|oga|opus|wav|m4a|aac|flac|mp4|webm|ttf|otf|woff2?|fnt|atlas|glb|gltf|obj|mtl|fbx|txt|xml|csv|tmx|tsx|tsj|ldtk|frag|vert|glsl|wgsl|lua|zip|br|gz|webmanifest|map|ya?ml|ini|cfg|dat|sav|pak|rpa|ase|aseprite";
const FILE_STRING = new RegExp(`["'\`]([^"'\`\\s<>{}()|^\\\\]{1,240}?\\.(?:${EXT}))(?:[?#][^"'\`\\s<>]*)?["'\`]`, "gi");
const ATTR = /\b(?:src|href|data-src|data|poster|srcset|content|data-iframe)\s*=\s*["']([^"']+)["']/gi;
const CSS_URL = /url\(\s*["']?([^"')]+?)["']?\s*\)|@import\s+["']([^"']+)["']/gi;
const TEXT_EXT = /\.(html?|m?js|css|json|webmanifest|svg|xml|txt)$/i;

/** The strings in a page, script or style that may name another file of the game. */
export function references(text: string, path: string): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const s = v?.trim().replace(/&amp;/g, "&");
    if (!s || s.length > 300 || /^(data|blob|javascript|mailto|tel|about):/i.test(s) || s.startsWith("#") || s.includes("${")) return;
    out.add(s);
  };
  if (/\.(html?|svg)$/i.test(path)) {
    for (const m of text.matchAll(ATTR)) {
      if (/srcset/i.test(m[0])) for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0]);
      else add(m[1]);
    }
  }
  if (/\.(html?|css|svg)$/i.test(path)) for (const m of text.matchAll(CSS_URL)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(FILE_STRING)) add(m[1]);
  // Godot: the page names the export ("executable": "index"); the engine adds the endings itself.
  for (const m of text.matchAll(/["'](?:executable|mainPack)["']\s*:\s*["']([^"']{1,200})["']/g)) {
    const name = m[1].replace(/\.(pck|wasm|js)$/i, "");
    for (const end of [".js", ".wasm", ".pck", ".side.wasm", ".worker.js", ".audio.worklet.js", ".audio.position.worklet.js", ".icon.png", ".apple-touch-icon.png", ".png"]) add(name + end);
    if (/\.pck$/i.test(m[1])) add(m[1]);
  }
  return [...out];
}

/** A path for an address: each part encoded, but characters that are fine in paths (like "@") kept. */
const urlPath = (path: string) =>
  path.split("/").map((p) => encodeURIComponent(p).replace(/%(40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))).join("/");

/** The folder a page is in ("/games/snake/" for /games/snake/index.html). */
const folderOf = (pathname: string) => pathname.slice(0, pathname.lastIndexOf("/") + 1);

/**
 * Downloads a game from where it runs: its page and every file of its folder that something
 * points to. Throws HostingError: move_unreachable (the page can't be read), too_big,
 * too_many_files, move_incomplete (a file the game needs didn't download), move_slow.
 */
export async function crawlGame(playUrl: string, o: CrawlOptions = {}): Promise<Crawled> {
  const fetchImpl = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.deadline ?? CRAWL_MS);
  const maxTries = o.maxTries ?? MAX_TRIES;
  const resolve = o.resolve ?? dnsLookup;
  const hosts = new Map<string, Promise<boolean>>();
  const isPublic = (url: string) => {
    if (!isCheckableUrl(url)) return Promise.resolve(false);
    const host = new URL(url).hostname;
    if (!hosts.has(host)) {
      hosts.set(host, resolve(host).then((a) => a.length > 0 && !a.some(privateAddress), () => false));
    }
    return hosts.get(host)!;
  };

  /** One file: its bytes, null when it doesn't exist; throws when it failed to download. */
  const get = async (url: string, timeout: number): Promise<{ url: string; data: Uint8Array; type: string } | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        let at = url;
        let res: Response | null = null;
        for (let hops = 0; hops <= 5; hops++) {
          if (!(await isPublic(at))) return null;
          res = await fetchImpl(at, { redirect: "manual", headers: { "user-agent": "TokiMove/1.0", accept: "*/*" }, signal: AbortSignal.timeout(timeout) });
          const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (!next) break;
          await res.body?.cancel().catch(() => {});
          at = new URL(next, at).toString();
          res = null;
        }
        if (!res) return null;
        if (res.status >= 400 && res.status < 500) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await readAll(res, MAX_GAME_BYTES - total + 1);
        return { url: at, data: recompress(url, res, data), type: res.headers.get("content-type") ?? "" };
      } catch (e) {
        if (e instanceof HostingError) throw e;
        if (attempt >= 3 || now() > deadline) throw new HostingError("move_incomplete", 422);
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  };

  let total = 0;
  const readAll = async (res: Response, max: number): Promise<Uint8Array> => {
    const len = Number(res.headers.get("content-length"));
    if (len > max) {
      await res.body?.cancel().catch(() => {});
      throw new HostingError("too_big", 413);
    }
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new HostingError("too_big", 413);
      }
      chunks.push(value);
    }
    return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks));
  };

  // The page itself. It may send us on (example.com/game → example.com/game/).
  let startUrl: URL;
  try {
    startUrl = new URL(playUrl);
  } catch {
    throw new HostingError("move_unreachable", 422);
  }
  startUrl.hash = "";
  startUrl.search = "";
  let page: Awaited<ReturnType<typeof get>>;
  try {
    page = await get(startUrl.toString(), 20_000);
  } catch (e) {
    if (e instanceof HostingError && e.code === "too_big") throw e;
    throw new HostingError("move_unreachable", 422);
  }
  if (!page || !/html/i.test(page.type) && !/<(html|head|body|script|canvas)\b/i.test(new TextDecoder().decode(page.data.subarray(0, 4000)))) {
    throw new HostingError("move_unreachable", 422);
  }
  const base = new URL(page.url);
  base.search = "";
  base.hash = "";
  const origin = base.origin;
  const folder = folderOf(base.pathname);
  let entry = decodeURIComponent(base.pathname.slice(folder.length)) || "index.html";
  if (!/\.html?$/i.test(entry)) entry = "index.html";

  /** The game's own name for a file at this address; null when it's outside the game's folder. */
  const pathFor = (u: URL): string | null => {
    if (u.origin !== origin || !u.pathname.startsWith(folder)) return null;
    let p: string;
    try {
      p = decodeURIComponent(u.pathname.slice(folder.length));
    } catch {
      return null;
    }
    if (p === "" || p.endsWith("/")) p += "index.html";
    return cleanPath(p);
  };

  const files = new Map<string, Uint8Array>();
  files.set(entry, page.data);
  total = page.data.length;
  const tried = new Set<string>([entry]);
  const queue: string[] = [];
  const dirs = new Set<string>(["", "Build/"]);
  const enqueue = (path: string) => {
    if (tried.has(path) || tried.size >= maxTries) return;
    tried.add(path);
    queue.push(path);
  };
  /** Every place a string could mean, relative to the file it's in and to the game's page. */
  const consider = (ref: string, from: string) => {
    let rel: URL[] = [];
    try {
      const fromUrl = new URL(urlPath(from), `${origin}${folder}`);
      rel = [new URL(ref, fromUrl), new URL(ref, base)];
      // "/web.data" pasted onto a folder name ("Build" + "/web.data"): try it in the folders seen so far.
      if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) {
        const bare = ref.replace(/^(\.\/|\/)+/, "");
        for (const d of dirs) rel.push(new URL(d + bare, base));
      }
    } catch {
      return;
    }
    for (const u of rel) {
      const p = pathFor(u);
      if (p) enqueue(p);
    }
  };
  let saveScript = false;
  const scan = (path: string, data: Uint8Array) => {
    if (data.length > SCAN_BYTES || !TEXT_EXT.test(path)) return;
    const text = new TextDecoder().decode(data);
    if (SAVE_SCRIPT.test(text)) saveScript = true;
    for (const ref of references(text, path)) consider(ref, path);
  };
  scan(entry, page.data);
  enqueue("toki.json");

  let busy = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const path = queue.shift();
        if (!path) {
          // Others may still add to the queue: wait for them before stopping.
          if (busy === 0) return;
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        busy++;
        try {
          if (now() > deadline) throw new HostingError("move_slow", 504);
          const got = await get(`${origin}${folder}${urlPath(path)}`, 60_000);
          if (!got) continue;
          if (files.size >= MAX_GAME_FILES) throw new HostingError("too_many_files", 413);
          total += got.data.length;
          if (total > MAX_GAME_BYTES) throw new HostingError("too_big", 413);
          files.set(path, got.data);
          const dir = path.slice(0, path.lastIndexOf("/") + 1);
          if (dir && dirs.size < 50) dirs.add(dir);
          scan(path, got.data);
        } finally {
          busy--;
        }
      }
    }),
  );

  const tokiFile = files.get("toki.json");
  const toki = tokiFile ? readTokiJson(new TextDecoder().decode(tokiFile)) : {};
  return {
    start: base.toString(),
    entry,
    files: [...files].map(([path, data]) => ({ path, data })),
    bytes: total,
    toki,
    saveScript,
  };
}

/**
 * Most servers send files compressed and fetch unpacks them. Files whose names say they are
 * packed (Unity's "web.wasm.br") must stay packed: the games Worker sends them as they are.
 */
function recompress(url: string, res: Response, data: Uint8Array): Uint8Array {
  const sent = (res.headers.get("content-encoding") ?? "").toLowerCase();
  const name = new URL(url).pathname.toLowerCase();
  if (name.endsWith(".br") && sent.includes("br")) return new Uint8Array(brotliCompressSync(data));
  if (name.endsWith(".gz") && sent.includes("gzip")) return new Uint8Array(gzipSync(data));
  return data;
}

// ---------- moving the game ----------

interface MoveGame {
  id: string;
  play_url: string;
  created_by: string | null;
  hosted_site: string | null;
  needs_isolation: boolean;
}

export interface MoveResult {
  play_url: string;
  /** Where the game ran before */
  from: string;
  files: number;
  bytes: number;
  /** Players' progress comes along (the game has Toki's save script) */
  saves: boolean;
}

/**
 * Downloads a game from its link and puts it live on Toki. Throws move_no_saves when the game
 * doesn't have Toki's save script (players' progress would stay behind), unless `anyway`.
 */
export async function moveGame(deps: Deps, user: HostUser, gameId: string, anyway = false, o: CrawlOptions & { put?: typeof fetch } = {}): Promise<MoveResult> {
  const { db } = deps;
  const [g] = await db.select<MoveGame>("games", `id=eq.${gameId}&select=id,play_url,created_by,hosted_site,needs_isolation`);
  if (!g) throw new HostingError("no_game", 404);
  if (user.role !== "admin" && g.created_by !== user.id) throw new HostingError("not_allowed", 403);
  const domain = deps.config.domain;
  const host = (() => {
    try {
      return new URL(g.play_url).hostname;
    } catch {
      return "";
    }
  })();
  if (host === domain || host.endsWith(`.${domain}`)) throw new HostingError("already_hosted", 409);

  const from = g.play_url;
  const got = await crawlGame(from, o);
  // Saves Toki already keeps for the game also show it has the script (e.g. bundled in a way the
  // download doesn't spot).
  const saves = got.saveScript || (await db.select("game_saves", `game_id=eq.${g.id}&select=game_id&limit=1`)).length > 0;
  if (!saves && !anyway) throw new HostingError("move_no_saves", 409);
  const toki: TokiJson = { ...got.toki, entry: got.entry };
  const start = await startUpload(deps, user, { game_id: g.id, toki, files: got.files.map((f) => ({ path: f.path, size: f.data.length })) });
  const byPath = new Map(got.files.map((f) => [f.path, f.data]));
  const put = o.put ?? fetch;
  const queue = [...start.uploads];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        const data = byPath.get(u.path)!;
        for (let attempt = 1; ; attempt++) {
          const res = await put(u.url, { method: "PUT", body: data as BodyInit, signal: AbortSignal.timeout(60_000) }).catch(() => null);
          if (res?.ok) break;
          if (attempt >= 3) throw new HostingError("storage_error", 502);
        }
      }
    }),
  );
  const done = await finishUpload(deps, user, { build_id: start.build_id, toki, isolation: toki.isolation ?? g.needs_isolation });
  // Remembered so players' progress can be picked up there (src/lib/movedSaves.ts).
  await db.update("games", `id=eq.${g.id}`, { moved_from: from, moved_at: (deps.now?.() ?? new Date()).toISOString() });
  return { play_url: done.play_url, from, files: done.files, bytes: done.bytes, saves };
}

/** Didn't work out: the game goes back to its old link, and its files on Toki are deleted. */
export async function moveBack(deps: Deps, user: HostUser, gameId: string): Promise<{ play_url: string }> {
  const { db, store } = deps;
  const [g] = await db.select<MoveGame & { moved_from: string | null }>("games", `id=eq.${gameId}&select=id,play_url,created_by,hosted_site,needs_isolation,moved_from`);
  if (!g) throw new HostingError("no_game", 404);
  if (user.role !== "admin" && g.created_by !== user.id) throw new HostingError("not_allowed", 403);
  const from = g.moved_from;
  if (!from) throw new HostingError("not_moved", 409);
  await db.update("games", `id=eq.${g.id}`, { play_url: from, moved_from: null, moved_at: null });
  await db.update("game_builds", `game_id=eq.${g.id}`, { status: "deleting", delete_after: (deps.now?.() ?? new Date()).toISOString() });
  if (g.hosted_site) await store.remove(`sites/${g.hosted_site}.json`);
  return { play_url: from };
}
