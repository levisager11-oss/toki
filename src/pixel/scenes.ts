// Small procedural pixel-art scenes used as game covers when no image is uploaded.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface G {
  w: number;
  h: number;
  px: (x: number, y: number, c: string) => void;
  rect: (x: number, y: number, w: number, h: number, c: string) => void;
  dither: (x: number, y: number, t: number, a: string, b: string) => string;
  grad: (a: string, b: string) => void;
  circle: (cx: number, cy: number, r: number, c: string) => void;
}

/** Where a scene's pixels go: a canvas in the browser, an image buffer on the server. */
export type Fill = (x: number, y: number, w: number, h: number, color: string) => void;

function make(fill: Fill, w: number, h: number): G {
  const rect = (x: number, y: number, rw: number, rh: number, c: string) => fill(Math.floor(x), Math.floor(y), rw, rh, c);
  const px = (x: number, y: number, c: string) => rect(x, y, 1, 1, c);
  const dither = (x: number, y: number, t: number, a: string, b: string) =>
    t * 16 > BAYER[y & 3][x & 3] ? b : a;
  const grad = (a: string, b: string) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x, y, dither(x, y, y / h, a, b));
  };
  const circle = (cx: number, cy: number, r: number, c: string) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) px(cx + x, cy + y, c);
  };
  return { w, h, px, rect, dither, grad, circle };
}

/** Still image: the star's own brightness. Animated: a few stars swap brightness each frame. */
const twinkle = (i: number, t: number, bright: boolean) => (t && (i * 7 + t) % 11 === 0 ? !bright : bright);

// t is the animation frame: 0 for the still image, counting up while a cover animates.
type Scene = (g: G, seed: number, t: number) => void;

const scenes: Record<string, Scene> = {
  deepsub(g, seed, t) {
    const r = rng(seed), { w, h, px } = g;
    g.grad("#0d3a3c", "#04171a");
    const cx = Math.round(w * 0.62), cy = Math.round(h * 0.5);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, (y - cy) * 1.15);
        if (d > 8 && d % 11 < 0.55 && d < w * 0.6) px(x, y, d < w * 0.3 ? "#2a7c72" : "#174c48");
      }
    for (let i = 0; i < (w * h) / 70; i++) px(r() * w, r() * h, "#1c5a55");
    const L = Math.max(10, Math.round(w * 0.12)), T = Math.max(3, Math.round(L * 0.28));
    for (let y = -T; y <= T; y++) for (let x = -L; x <= L; x++) if ((x / L) ** 2 + (y / T) ** 2 <= 1) px(cx + x, cy + y, "#3fa293");
    g.rect(cx - Math.round(L * 0.25), cy - T - Math.round(T * 0.9), Math.round(L * 0.45), Math.round(T * 0.9) + 1, "#3fa293");
    g.rect(cx, cy - T - Math.round(T * 1.9), 1, Math.round(T), "#3fa293");
    for (let i = -1; i <= 1; i++) px(cx + i * Math.round(L * 0.4), cy, "#b8ffe8");
    for (let i = 0; i < 6; i++) {
      const bx = cx + L + 2 + r() * 4, by = cy - 2 + r() * 4;
      px(bx + (t ? ((t + i) >> 2) % 2 : 0), by - ((t + i * 5) % (cy + 2)), "#7fd8c4");
    }
  },
  sky(g, _seed, t) {
    const { w, h } = g;
    g.grad("#68b8ea", "#cdeaf7");
    g.circle(Math.round(w * 0.7), Math.round(h * 0.3), Math.round(h * 0.14), "#fff1b0");
    const cw = Math.max(8, Math.round(w * 0.14)), cy = Math.round(h * 0.18);
    const cx = ((Math.round(w * 0.12) + t) % (w + cw)) - cw;
    g.rect(cx, cy, cw, 2, "#ffffff");
    g.rect(cx + 2, cy - 2, cw - 5, 2, "#ffffff");
    const mtn = (p: number, peak: number, c: string) => {
      for (let x = 0; x < w; x++) {
        const top = h - (peak - Math.abs(x - p) * 0.9);
        for (let y = Math.max(0, Math.round(top)); y < h; y++) g.px(x, y, c);
      }
    };
    mtn(w * 0.25, h * 0.55, "#4a9c7b");
    mtn(w * 0.75, h * 0.45, "#2f7a5e");
    g.rect(Math.round(w * 0.3), Math.round(h * 0.45), 3, 3, "#ff5b4a");
  },
  orbit(g, seed, t) {
    const r = rng(seed), { w, h } = g;
    g.grad("#1d1838", "#090814");
    for (let i = 0; i < 40; i++) g.px(r() * w, r() * h, twinkle(i, t, r() > 0.5) ? "#cfd3ff" : "#6a6ea8");
    const cx = (w * 0.55) | 0, cy = (h * 0.52) | 0, R = (h * 0.22) | 0;
    const ring = (front: boolean, c: string) => {
      for (let a = 0; a < Math.PI * 2; a += 0.01)
        if (Math.sin(a) >= 0 === front) g.px(cx + Math.cos(a) * R * 2.1, cy + Math.sin(a) * R * 0.55, c);
    };
    ring(false, "#a88a52");
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++)
        if (x * x + y * y <= R * R) g.px(cx + x, cy + y, g.dither(cx + x, cy + y, (x + y + R * 2) / (R * 4), "#ff8a5c", "#c4472e"));
    ring(true, "#e8c07d");
  },
  blocks(g, seed, t) {
    const r = rng(seed), { w, h } = g;
    g.rect(0, 0, w, h, "#1f2328");
    for (let x = 0; x < w; x += 4) for (let y = 0; y < h; y += 4) g.px(x, y, "#2a2f36");
    const cols = ["#ffd23f", "#4fb3ff", "#ff5b4a", "#4ccf7e", "#b07cff"];
    for (let gx = 0; gx < w / 4; gx++) {
      const hgt = 2 + ((r() * 4) | 0);
      for (let gy = 0; gy < hgt; gy++) g.rect(gx * 4, h - (gy + 1) * 4, 4, 4, cols[(gx * 3 + gy) % 5]);
    }
    const m = (w / 2) | 0, fall = t % Math.max(1, h - 32);
    g.rect(m, 8 + fall, 4, 4, "#b07cff");
    g.rect(m + 4, 4 + fall, 4, 12, "#b07cff");
  },
  racer(g, _seed, frame) {
    const { w, h } = g;
    const hz = (h * 0.45) | 0;
    g.grad("#2a1840", "#7a3b5c");
    g.rect(0, hz, w, h - hz, "#1b1426");
    for (let y = hz; y < h; y++) {
      const t = (y - hz) / (h - hz), half = 2 + t * w * 0.45;
      g.rect((w / 2 - half) | 0, y, (half * 2) | 0, 1, "#3a3346");
      if ((((y - frame) % 6) + 6) % 6 < 3) g.rect((w / 2) | 0, y, 1 + ((t * 2) | 0), 1, "#ffd23f");
    }
    const m = (w / 2) | 0;
    g.rect(m - 6, h - 10, 12, 5, "#ff5b4a");
    g.rect(m - 4, h - 13, 8, 3, "#ff8a7a");
    g.px(m - 6, h - 6, "#ffd23f");
    g.px(m + 5, h - 6, "#ffd23f");
  },
  slime(g, seed, t) {
    const r = rng(seed), { w, h } = g;
    g.grad("#1f2b22", "#121a14");
    for (let x = 0; x < w; x += 6) {
      const l = (2 + r() * 8) | 0;
      for (let y = 0; y < l; y++) g.rect(x + (y >> 2), y, Math.max(1, 4 - (y >> 1)), 1, "#2f3f33");
    }
    g.rect(0, h - 6, w, 6, "#2f3f33");
    const cx = (w / 2) | 0, cy = h - 12 - (t % 6 < 3 ? 0 : 1);
    for (let y = -7; y <= 6; y++) for (let x = -10; x <= 10; x++) if ((x / 10) ** 2 + (y / 7) ** 2 <= 1) g.px(cx + x, cy + y, "#7ad66a");
    g.rect(cx - 4, cy - 2, 2, 3, "#10200f");
    g.rect(cx + 3, cy - 2, 2, 3, "#10200f");
    g.rect(cx - 6, cy - 5, 2, 1, "#c4f5b8");
  },
  stars(g, seed, t) {
    const r = rng(seed), { w, h } = g;
    g.grad("#141a3a", "#0a0d1f");
    for (let i = 0; i < 50; i++) g.px(r() * w, r() * h, twinkle(i, t, r() > 0.7) ? "#ffffff" : "#5b6699");
    const sx = (w * 0.3) | 0, sy = (h * 0.6) | 0;
    for (let i = 0; i < 9; i++) g.rect(sx + i, sy - (i >> 1), 1, Math.max(1, 9 - i), "#e8ebff");
    g.rect(sx - 3 - (t % 2), sy + 2, 3 + (t % 2), 2, t % 2 ? "#ffd23f" : "#ff8a5c");
    const px = (w * 0.75) | 0, py = (h * 0.3) | 0;
    g.circle(px, py, 6, "#b07cff");
    g.circle(px - 2, py - 2, 2, "#d8b8ff");
  },
  dungeon(g, seed, t) {
    const r = rng(seed), { w, h } = g;
    g.rect(0, 0, w, h, "#2b2420");
    for (let y = 0; y < h; y += 6)
      for (let x = (y / 6) % 2 ? 0 : -6; x < w; x += 12) {
        g.rect(x, y, 11, 5, r() > 0.5 ? "#3a312b" : "#342c26");
      }
    const tx = (w * 0.22) | 0;
    g.rect(tx, (h * 0.35) | 0, 2, 6, "#6b4f35");
    g.rect(tx - 1, ((h * 0.35) | 0) - 3, 4, 3, "#ffb347");
    g.px(tx + (t % 3 === 1 ? 1 : 0), ((h * 0.35) | 0) - 4 - (t % 4 === 2 ? 1 : 0), "#ffe08a");
    const kx = (w * 0.6) | 0, ky = h - 18;
    g.rect(kx, ky, 6, 6, "#c9ced6");
    g.rect(kx + 1, ky + 2, 4, 1, "#1b1f24");
    g.rect(kx, ky + 6, 6, 6, "#4f7cc4");
    g.rect(kx + 7, ky + 1, 1, 10, "#e6e9ee");
    g.rect(0, h - 6, w, 6, "#1a1512");
  },
};

export const COVERS = Object.keys(scenes);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function coverFor(slug: string, cover: string | null) {
  return cover && scenes[cover] ? cover : COVERS[hash(slug) % COVERS.length];
}

export function renderScene(fill: Fill, name: string, seedText: string, w: number, h: number, t = 0) {
  (scenes[name] ?? scenes.sky)(make(fill, w, h), hash(seedText), t);
}

export function drawCover(canvas: HTMLCanvasElement, name: string, seedText: string, w = 64, h = 48, t = 0) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  renderScene((x, y, rw, rh, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, rw, rh);
  }, name, seedText, w, h, t);
}
