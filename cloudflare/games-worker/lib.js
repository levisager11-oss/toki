// Small helpers of the games Worker, kept apart so Toki's tests can check them (tests/worker.test.ts).

/** "snake" for snake.playtoki.app; null for anything else (Toki itself, www, deeper names). */
export function siteFrom(hostname, domain, reserved) {
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${domain}`)) return null;
  const site = host.slice(0, -domain.length - 1);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site) || site.length > 50 || reserved.has(site)) return null;
  return site;
}

/** The file asked for, inside the game; null when the path tries to leave it. */
export function filePath(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  p = p.normalize("NFC").replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  if (p.split("/").some((s) => s === "." || s === "..") || /[\u0000-\u001f\\]/.test(p)) return null;
  return p;
}

const TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", wasm: "application/wasm", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", txt: "text/plain; charset=utf-8", xml: "application/xml",
  pck: "application/octet-stream", data: "application/octet-stream", unityweb: "application/octet-stream", bin: "application/octet-stream",
  glb: "model/gltf-binary", gltf: "model/gltf+json", map: "application/json", webmanifest: "application/manifest+json",
};

/**
 * The content type, and the encoding for files that were compressed ahead (Unity's .gz/.br builds):
 * "Build.wasm.br" is WebAssembly, sent as Brotli.
 */
export function typeOf(path) {
  const name = path.split("/").pop().toLowerCase();
  let encoding = null;
  let base = name;
  if (name.endsWith(".br")) [encoding, base] = ["br", name.slice(0, -3)];
  else if (name.endsWith(".gz")) [encoding, base] = ["gzip", name.slice(0, -3)];
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return { type: TYPES[ext] ?? "application/octet-stream", encoding };
}

export const isHtml = (path) => /\.html?$/i.test(path);
