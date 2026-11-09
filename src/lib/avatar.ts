// Pixel avatars: a small symmetric 8×8 creature drawn from a seed (by default the username),
// so every player has one without uploading anything. And shrinking uploaded pictures in the
// browser, so avatars stay tiny in storage.

/** 32-bit FNV-1a hash, then a small random generator seeded with it. */
function rng(seed: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}

const BG = ["#ffd23f", "#7bdff2", "#b2f7ef", "#f7a8b8", "#c3aed6", "#a0e7a0", "#ffb385", "#e9ebee"];
const FG = ["#101317", "#2b2d42", "#3a0ca3", "#7a1f2b", "#1b4332", "#5a189a", "#003049", "#6a040f"];

export interface PixelAvatar {
  bg: string;
  fg: string;
  /** 8 rows of 8 cells: true = filled */
  cells: boolean[][];
}

export function pixelAvatar(seed: string): PixelAvatar {
  const r = rng(seed || "toki");
  const bg = BG[Math.floor(r() * BG.length)];
  const fg = FG[Math.floor(r() * FG.length)];
  const cells: boolean[][] = [];
  for (let y = 0; y < 8; y++) {
    const half = [0, 1, 2, 3].map((x) => {
      if (y === 0 || y === 7) return false; // a border of background
      if (x === 0) return r() < 0.25;
      return r() < 0.55;
    });
    cells.push([...half, ...[...half].reverse()]);
  }
  // Eyes, so it reads as a face.
  cells[3][2] = cells[3][5] = false;
  cells[2][2] = cells[2][5] = true;
  return { bg, fg, cells };
}

/** A new random seed, for "draw another one". */
export const randomSeed = () => Math.random().toString(36).slice(2, 10);

/** Shrinks a picture to a square of `size` pixels (cut to fill) as WebP, at most `maxBytes`. */
export async function shrinkImage(file: Blob, size = 128, maxBytes = 100_000): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", quality));
    // Safari before 17 can't make WebP and gives PNG instead: fine, it's still small at 128px.
    if (blob && blob.size <= maxBytes) return blob;
  }
  const jpeg = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.6));
  if (jpeg && jpeg.size <= maxBytes) return jpeg;
  throw new Error("too big");
}
