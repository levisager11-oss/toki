// Game pictures (cover, banner, screenshots): shrunk in the browser before upload, and deleted
// from storage once nothing uses them any more, so Toki stays on Supabase's free plan.
import { supabase } from "./supabase";

const BUCKET = "thumbnails";
const MARKER = `/storage/v1/object/public/${BUCKET}/`;
// Small enough pictures go up as they are.
const KEEP_BYTES = 300_000;

/** Width and height that fit into maxSide, keeping the shape. Never larger than the picture. */
export function fitSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));

/**
 * The picture at most maxSide pixels wide or high, as WebP (or PNG/JPEG where the browser can't
 * make WebP). Animated GIFs and pictures that are small already stay as they are.
 */
export async function shrinkGameImage(file: File, maxSide: number): Promise<Blob> {
  if (file.type === "image/gif") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // the server checks the type; nothing to shrink here
  }
  const { w, h } = fitSize(bitmap.width, bitmap.height, maxSide);
  if (w === bitmap.width && file.size <= KEEP_BYTES) {
    bitmap.close?.();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  let out = await toBlob(canvas, "image/webp", 0.86);
  // Older Safari makes PNG when asked for WebP: keep PNG for PNGs (see-through parts), else JPEG.
  if (!out || out.type !== "image/webp") out = file.type === "image/png" ? await toBlob(canvas, "image/png") : await toBlob(canvas, "image/jpeg", 0.86);
  return out && out.size < file.size ? out : file;
}

const EXT: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
export const extFor = (type: string) => EXT[type] ?? "png";

/** The file's place in Toki's storage, or null for pictures stored elsewhere. */
export function storagePath(url: string | null | undefined): string | null {
  const i = url?.indexOf(MARKER) ?? -1;
  return url && i >= 0 ? decodeURIComponent(url.slice(i + MARKER.length).split("?")[0]) : null;
}

/** Deletes pictures from storage. Only the uploader may; for anyone else nothing happens. */
export async function removeGameImages(urls: (string | null | undefined)[]): Promise<void> {
  const paths = [...new Set(urls.map(storagePath).filter((p): p is string => !!p))];
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
}
