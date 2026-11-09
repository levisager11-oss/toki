import { describe, expect, it } from "vitest";
import { extFor, fitSize, storagePath } from "../src/lib/gameImages";

describe("fitSize", () => {
  it("shrinks large pictures and keeps their shape", () => {
    expect(fitSize(4000, 2000, 2000)).toEqual({ w: 2000, h: 1000 });
    expect(fitSize(1000, 3000, 1500)).toEqual({ w: 500, h: 1500 });
  });
  it("never makes pictures larger", () => expect(fitSize(320, 180, 1200)).toEqual({ w: 320, h: 180 }));
});

describe("storagePath", () => {
  const base = "https://x.supabase.co/storage/v1/object/public/thumbnails/";
  it("finds the file of a Toki picture", () => {
    expect(storagePath(`${base}user-1/abc.webp`)).toBe("user-1/abc.webp");
    expect(storagePath(`${base}user-1/a%20b.png?v=2`)).toBe("user-1/a b.png");
  });
  it("ignores pictures stored elsewhere", () => {
    expect(storagePath("https://example.com/cover.png")).toBeNull();
    expect(storagePath("https://x.supabase.co/storage/v1/object/public/avatars/u/a.webp")).toBeNull();
    expect(storagePath(null)).toBeNull();
  });
});

describe("extFor", () => {
  it("names files by their type", () => {
    expect(extFor("image/webp")).toBe("webp");
    expect(extFor("image/jpeg")).toBe("jpg");
    expect(extFor("image/x-unknown")).toBe("png");
  });
});
