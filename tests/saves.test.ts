import { describe, expect, it } from "vitest";
import { asSave, newest } from "../src/lib/saves";
import { safeNext } from "../src/lib/nav";

describe("asSave", () => {
  it("accepts a save", () => expect(asSave({ keys: { a: "1" }, t: 5 })).toEqual({ keys: { a: "1" }, t: 5 }));
  it.each([null, "x", { keys: {}, t: 0 }, { keys: { a: 1 }, t: 5 }, { keys: [], t: 5 }, { keys: { a: "1" } }, { keys: { a: "1" }, t: NaN }])(
    "rejects %j",
    (v) => expect(asSave(v)).toBeNull(),
  );
  it("rejects saves over 1 MB", () => expect(asSave({ keys: { a: "x".repeat(1_000_001) }, t: 5 })).toBeNull());
});

describe("newest", () => {
  const a = { keys: {}, t: 1 }, b = { keys: {}, t: 2 };
  it("picks the newest save", () => expect(newest(a, null, b, undefined)).toBe(b));
  it("handles nothing", () => expect(newest(null, undefined)).toBeNull());
});

describe("safeNext", () => {
  it("allows pages on this site", () => expect(safeNext("/game/deepsub")).toBe("/game/deepsub"));
  it.each([null, "https://evil.example", "//evil.example", "javascript:alert(1)"])("falls back to home for %s", (v) =>
    expect(safeNext(v)).toBe("/"));
});
