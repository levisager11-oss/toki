import { renderScene } from "../src/pixel/scenes.js";
import { encodePng } from "./png.js";

// Link preview size is 1200x630: the pixel scene is drawn at 120x63 and each pixel becomes a 10x10 block.
export const SCALE = 10;
export const SCENE_W = 120;
export const SCENE_H = 63;

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Draws a cover scene into RGB pixels at the given size. */
export function sceneRgb(name: string, seedText: string, w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  renderScene((x, y, rw, rh, color) => {
    const [r, g, b] = hex(color);
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) {
        const i = (yy * w + xx) * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
  }, name, seedText, w, h);
  return px;
}

/** Scales pixels up by whole blocks so the image stays crisp. */
export function upscale(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const W = w * k, out = new Uint8Array(W * h * k * 3);
  for (let y = 0; y < h * k; y++)
    for (let x = 0; x < W; x++) {
      const s = (((y / k) | 0) * w + ((x / k) | 0)) * 3, d = (y * W + x) * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
  return out;
}

export function coverPng(name: string, seedText: string): Buffer {
  const small = sceneRgb(name, seedText, SCENE_W, SCENE_H);
  return encodePng(SCENE_W * SCALE, SCENE_H * SCALE, upscale(small, SCENE_W, SCENE_H, SCALE));
}
