// Toki's games Worker: serves every game hosted on Toki at its own address (<site>.playtoki.app)
// from the Cloudflare R2 bucket. Toki's server writes the files (b/<build>/<path>) and a small
// pointer per game (sites/<site>.json: which build is live). This Worker only reads.
// Setup: docs/hosting-setup.md.
import { filePath, isHtml, siteFrom, typeOf } from "./lib.js";

const pointers = new Map(); // site -> { at, value }, a short memory to save R2 reads
const POINTER_MS = 15_000;

async function pointer(env, site) {
  const hit = pointers.get(site);
  if (hit && Date.now() - hit.at < POINTER_MS) return hit.value;
  const obj = await env.BUCKET.get(`sites/${site}.json`);
  const value = obj ? await obj.json() : null;
  pointers.set(site, { at: Date.now(), value });
  return value;
}

const text = (body, status) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

// Files of a build never change once it is live (every upload is a new build id), so a copy in
// Cloudflare's cache next to the Worker saves the R2 read. Bigger files are read from R2 each time.
const CACHE_MAX_BYTES = 50 * 1024 * 1024;
const CACHE_SECONDS = 24 * 60 * 60;

/** Looks a file up in the edge cache; { body, size, etag } or null. */
async function cached(cache, key) {
  const hit = await cache.match(key);
  if (!hit) return null;
  return { body: hit.body, size: Number(hit.headers.get("content-length") ?? 0), etag: hit.headers.get("x-toki-etag") };
}

/** Keeps a copy of an R2 file for the next visitor (after the answer is on its way). */
function remember(ctx, cache, key, obj, copy) {
  ctx.waitUntil(
    cache
      .put(key, new Response(copy, { headers: { "content-length": String(obj.size), "cache-control": `public, max-age=${CACHE_SECONDS}`, "x-toki-etag": obj.httpEtag } }))
      .catch(() => {}),
  );
}

/** Does the browser's If-None-Match list (or "*") contain this etag? */
const sameEtag = (header, etag) => !!header && !!etag && (header.trim() === "*" || header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reserved = new Set((env.RESERVED ?? "www").split(",").map((s) => s.trim()).filter(Boolean));
    const site = siteFrom(url.hostname, env.DOMAIN, reserved);
    // Not a game (e.g. www.playtoki.app when it runs through Cloudflare): pass it on unchanged.
    if (!site) return fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);

    const live = await pointer(env, site);
    if (!live?.build) return text("This game isn't on Toki (any more).", 404);
    let path = filePath(url.pathname);
    if (!path) return text("Not found", 404);

    // Plain GETs (no Range) can come from the edge cache; everything else asks R2.
    const cache = request.method === "GET" && !request.headers.has("range") && ctx && typeof caches !== "undefined" ? caches.default : null;
    const key = cache ? new Request(`${url.origin}/__build/${live.build}/${path.split("/").map(encodeURIComponent).join("/")}`) : null;

    let obj = cache ? await cached(cache, key) : null;
    if (obj && sameEtag(request.headers.get("if-none-match"), obj.etag)) {
      obj.body?.cancel();
      obj = { httpEtag: obj.etag, size: obj.size }; // no "body": answered with 304 below
    } else if (obj) {
      obj.httpEtag = obj.etag;
    } else {
      obj = await env.BUCKET.get(`b/${live.build}/${path}`, { onlyIf: request.headers, range: request.headers });
      // Only a whole, unconditional answer is kept (not a 304 or a part of a file).
      if (obj && cache && "body" in obj && !obj.range && obj.size <= CACHE_MAX_BYTES && !request.headers.has("if-none-match") && !request.headers.has("if-modified-since")) {
        const [toBrowser, toCache] = obj.body.tee();
        remember(ctx, cache, key, obj, toCache);
        obj = { body: toBrowser, httpEtag: obj.httpEtag, size: obj.size, range: obj.range };
      }
    }
    if (!obj && !path.split("/").pop().includes(".")) {
      // A folder without its slash: send the browser to it, so the game's own links work.
      const inside = await env.BUCKET.head(`b/${live.build}/${path}/index.html`);
      if (inside) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    }
    if (!obj) return text("Not found", 404);

    const { type, encoding } = typeOf(path);
    const headers = new Headers({
      "content-type": type,
      etag: obj.httpEtag,
      // HTML is checked every time; other files may be reused for a minute (a new version
      // keeps its file names, so longer would mix versions).
      "cache-control": isHtml(path) ? "no-cache" : "public, max-age=60",
      "accept-ranges": "bytes",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    if (encoding) headers.set("content-encoding", encoding);
    if (live.isolation) {
      headers.set("cross-origin-embedder-policy", "require-corp");
      headers.set("cross-origin-opener-policy", "same-origin");
    }

    if (!("body" in obj)) return new Response(null, { status: 304, headers });
    let status = 200;
    if (obj.range && request.headers.has("range")) {
      const offset = obj.range.offset ?? 0;
      const length = obj.range.length ?? obj.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      status = 206;
    }
    const body = request.method === "HEAD" ? null : obj.body;
    let res = new Response(body, { status, headers, encodeBody: encoding ? "manual" : "automatic" });

    // The game's start page gets Toki's save script first thing, so saves work without changes.
    if (body && path === live.entry && isHtml(path) && !encoding && status === 200 && env.SAVE_SCRIPT) {
      res = new HTMLRewriter()
        .on("head", { element: (el) => el.prepend(`<script src="${env.SAVE_SCRIPT}"></script>`, { html: true }) })
        .transform(res);
    }
    return res;
  },
};
