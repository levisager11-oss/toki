import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkHeaders, isCheckableUrl } from "../server/embed-check";
import { gameSlug, needsIsolation } from "../server/isolation";
import { injectMeta, PREVIEW_BOT } from "../server/meta";
import { encodePng } from "../server/png";
import { coverPng, sceneRgb } from "../server/cover-image";
import { COVERS, renderScene } from "../src/pixel/scenes";

const TOKI = "https://toki.vercel.app";

describe("checkHeaders", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const good = { "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "cross-origin" };
  it("accepts a correctly set up game", () => expect(checkHeaders(h(good), TOKI)).toEqual({ framable: true, isolation: true }));
  it("flags X-Frame-Options", () => {
    expect(checkHeaders(h({ ...good, "x-frame-options": "DENY" }), TOKI).framable).toBe(false);
    expect(checkHeaders(h({ ...good, "x-frame-options": "SAMEORIGIN" }), TOKI).framable).toBe(false);
  });
  it("reads CSP frame-ancestors", () => {
    expect(checkHeaders(h({ "content-security-policy": "frame-ancestors 'self'" }), TOKI).framable).toBe(false);
    expect(checkHeaders(h({ "content-security-policy": "default-src 'self'; frame-ancestors *" }), TOKI).framable).toBe(true);
    expect(checkHeaders(h({ "content-security-policy": `frame-ancestors ${TOKI}` }), TOKI).framable).toBe(true);
    expect(checkHeaders(h({ "content-security-policy": "frame-ancestors https://*.vercel.app" }), TOKI).framable).toBe(true);
  });
  it("notices missing isolation headers", () => expect(checkHeaders(h({}), TOKI)).toEqual({ framable: true, isolation: false }));
});

describe("isCheckableUrl", () => {
  it.each(["https://game.vercel.app", "https://user.github.io/game/"])("allows %s", (u) => expect(isCheckableUrl(u)).toBe(true));
  it.each(["http://game.dev", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://printer.local", "https://a.b:8443", "nonsense", "https://intranet"])(
    "rejects %s",
    (u) => expect(isCheckableUrl(u)).toBe(false),
  );
});

describe("injectMeta", () => {
  const html = `<html><head>\n<title>Toki</title>\n<meta name="description" content="old" />\n<meta property="og:title" content="Toki" />\n</head><body></body></html>`;
  const out = injectMeta(html, { title: `Deep "Sub" <3`, description: "Dive\n deep", image: "https://x/og.png", url: "https://x/game/deep" });
  it("replaces the title and description, escaped", () => {
    expect(out).toContain("<title>Deep &quot;Sub&quot; &lt;3</title>");
    expect(out).toContain(`<meta name="description" content="Dive deep" />`);
  });
  it("adds preview tags once", () => {
    expect(out.match(/og:title/g)).toHaveLength(1);
    expect(out).toContain(`<meta property="og:image" content="https://x/og.png" />`);
    expect(out).toContain("summary_large_image");
  });
});

describe("PREVIEW_BOT", () => {
  it("matches chat apps but not browsers", () => {
    expect(PREVIEW_BOT.test("WhatsApp/2.23.20.0")).toBe(true);
    expect(PREVIEW_BOT.test("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")).toBe(true);
    expect(PREVIEW_BOT.test("facebookexternalhit/1.1")).toBe(true);
    expect(PREVIEW_BOT.test("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1")).toBe(false);
  });
});

describe("encodePng", () => {
  it("writes a valid PNG", () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 0, 255]);
  });
});

describe("pixel scenes", () => {
  it.each(COVERS)("%s draws, still and animated", (name) => {
    expect(sceneRgb(name, "some-game", 64, 48).length).toBe(64 * 48 * 3);
    for (const t of [0, 1, 50, 10_000]) {
      let calls = 0;
      renderScene(() => calls++, name, "some-game", 64, 48, t);
      expect(calls).toBeGreaterThan(0);
    }
  });
  it("is the same every time for the same game", () => expect(sceneRgb("stars", "a", 32, 24)).toEqual(sceneRgb("stars", "a", 32, 24)));
  it("moves when animated", () => {
    const frame = (t: number) => {
      const seen: string[] = [];
      renderScene((x, y, w, h, c) => seen.push(`${x},${y},${w},${h},${c}`), "racer", "a", 64, 48, t);
      return seen.join("|");
    };
    expect(frame(0)).not.toBe(frame(1));
  });
  it("makes a 1200x630 preview image", () => {
    const png = coverPng("orbit", "toki");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});

describe("isolation", () => {
  it("finds game pages", () => {
    expect(gameSlug("/game/deepsub")).toBe("deepsub");
    expect(gameSlug("/game/deepsub/")).toBe("deepsub");
    expect(gameSlug("/")).toBeUndefined();
    expect(gameSlug("/edit/deepsub")).toBeUndefined();
  });
  const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  it("is on only when the game says so", async () => {
    expect(await needsIsolation("iso-on", reply([{ needs_isolation: true }]))).toBe(true);
    expect(await needsIsolation("iso-off", reply([{ needs_isolation: false }]))).toBe(false);
    expect(await needsIsolation("iso-missing", reply([]))).toBe(false);
  });
  it("is off when the database can't be asked, so games still load", async () => {
    expect(await needsIsolation("iso-error", reply(null, false))).toBe(false);
    expect(await needsIsolation("iso-throws", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBe(false);
  });
});
