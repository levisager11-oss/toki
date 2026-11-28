// Link preview picture for a shared high score (1200x630): the game's screenshot, the player,
// the score and their place. Asked for by the preview of "/game/<slug>?by=<username>".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { ordinal, sharedScore } from "../server/score-share.js";

const font = (f: string) => readFileSync(join(process.cwd(), "server/fonts", f));
let fonts: { name: string; data: Buffer; weight: 400 | 500 | 800 | 900 }[] | null = null;
const loadFonts = () =>
  (fonts ??= [
    { name: "Grot", data: font("schibsted-grotesk-latin-500-normal.woff"), weight: 500 },
    { name: "Grot", data: font("schibsted-grotesk-latin-800-normal.woff"), weight: 800 },
    { name: "Grot", data: font("schibsted-grotesk-latin-900-normal.woff"), weight: 900 },
    { name: "Silk", data: font("silkscreen-latin-400-normal.woff"), weight: 400 },
  ]);

// Toki's gamepad (public/favicon.svg) in yellow, without its dark square.
const PAD = (() => {
  const cells = [
    "3,4", "4,4", "5,4", "6,4", "7,4", "8,4", "9,4", "10,4", "11,4", "12,4",
    "2,5", "3,5", "4,5", "5,5", "6,5", "7,5", "8,5", "9,5", "10,5", "11,5", "12,5", "13,5",
    "1,6", "2,6", "3,6", "4,6", "6,6", "7,6", "8,6", "9,6", "10,6", "11,6", "13,6", "14,6",
    "1,7", "2,7", "3,7", "7,7", "8,7", "9,7", "10,7", "12,7", "14,7",
    "1,8", "2,8", "3,8", "4,8", "6,8", "7,8", "8,8", "9,8", "10,8", "11,8", "13,8", "14,8",
    "1,9", "2,9", "3,9", "4,9", "5,9", "6,9", "7,9", "8,9", "9,9", "10,9", "11,9", "12,9", "13,9", "14,9",
    "1,10", "2,10", "3,10", "4,10", "5,10", "10,10", "11,10", "12,10", "13,10", "14,10",
    "1,11", "2,11", "3,11", "4,11", "11,11", "12,11", "13,11", "14,11",
    "2,12", "3,12", "12,12", "13,12",
  ].map((c) => { const [x, y] = c.split(","); return `<rect x="${x}" y="${y}" width="1" height="1"/>`; }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 4 14 9" shape-rendering="crispEdges"><g fill="#ffd23f">${cells}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
})();

/** A game picture as a data URL, or null when it can't be loaded quickly. */
async function picture(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpe?g)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, ...children: (Node | string | null)[]): Node => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.filter((c) => c !== null) },
});
const img = (src: string, style: Record<string, unknown>): Node => ({ type: "img", props: { src, style } });

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const s = await sharedScore(q.get("game") ?? "", q.get("by") ?? "").catch(() => null);
  if (!s) return new Response("Not found", { status: 404 });
  let bg: string | null = null;
  for (const u of s.images.slice(0, 2)) if ((bg = await picture(u))) break;

  const scoreSize = s.shown.length <= 6 ? 150 : s.shown.length <= 9 ? 124 : 100;
  const card = el(
    "div",
    { width: 1200, height: 630, position: "relative", background: "#0e1013", fontFamily: "Grot", color: "#fff" },
    bg ? img(bg, { position: "absolute", left: 0, top: 0, width: 1200, height: 630, objectFit: "cover" }) : null,
    el("div", {
      position: "absolute", left: 0, top: 0, width: 1200, height: 630,
      backgroundImage: "linear-gradient(90deg, rgba(14,16,19,0.97) 0%, rgba(14,16,19,0.9) 45%, rgba(14,16,19,0.45) 100%)",
    }),
    el(
      "div",
      { position: "absolute", left: 64, top: 56, alignItems: "center" },
      img(PAD, { width: 58, height: 38 }),
      el("div", { fontFamily: "Silk", fontSize: 30, letterSpacing: 6, marginLeft: 18, color: "#e8ebee" }, "TOKI"),
    ),
    el(
      "div",
      { position: "absolute", left: 64, top: 150, flexDirection: "column", width: 900 },
      el("div", { fontSize: 38, fontWeight: 800, color: "#c3cad2" }, `@${s.username}`),
      el("div", { fontSize: scoreSize, fontWeight: 900, letterSpacing: -4, lineHeight: 1, marginTop: 6 }, s.shown),
      el("div", { fontSize: 52, fontWeight: 800, color: "#ffd23f", marginTop: 8 }, `in ${s.title}`),
      el(
        "div",
        { marginTop: 26, alignSelf: "flex-start", fontSize: 26, fontWeight: 800, padding: "10px 20px", borderRadius: 999, background: "#1f242b", color: "#e8ebee", border: "1px solid #2f363f" },
        `${ordinal(s.rank)} place on the leaderboard`,
      ),
    ),
    el(
      "div",
      { position: "absolute", left: 64, bottom: 52, alignItems: "center", fontSize: 30, fontWeight: 800, padding: "14px 26px", borderRadius: 14, background: "#ffd23f", color: "#101317" },
      "Can you beat it? · playtoki.app",
    ),
  );
  const svg = await satori(card as unknown as Parameters<typeof satori>[0], { width: 1200, height: 630, fonts: loadFonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  return new Response(new Uint8Array(png), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=600" },
  });
}
