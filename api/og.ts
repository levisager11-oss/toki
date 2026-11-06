// Link preview image for a game without an uploaded cover: its pixel scene, 1200x630.
import { COVERS, coverFor } from "../src/pixel/scenes.js";
import { coverPng } from "../server/cover-image.js";

export function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const slug = (q.get("slug") ?? "toki").slice(0, 40);
  const cover = q.get("cover");
  const name = coverFor(slug, cover && COVERS.includes(cover) ? cover : null);
  return new Response(new Uint8Array(coverPng(name, slug)), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400, s-maxage=604800" },
  });
}
