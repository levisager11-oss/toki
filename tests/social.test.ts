import { describe, expect, it } from "vitest";
import { pixelAvatar } from "../src/lib/avatar";
import { formatScore, isOnline, socialErrorKey, validScore } from "../src/lib/social";

describe("formatScore", () => {
  it("shows points with separators", () => {
    expect(formatScore(1234567, "points", "en")).toBe("1,234,567");
    expect(formatScore(12.6, "points", "en")).toBe("13");
  });
  it("shows times from milliseconds", () => {
    expect(formatScore(62_345, "time", "en")).toBe("1:02.345");
    expect(formatScore(5_000, "time", "en")).toBe("0:05.000");
    expect(formatScore(3_725_004, "time", "en")).toBe("1:02:05.004");
  });
});

describe("validScore", () => {
  it("accepts finite numbers in range only", () => {
    expect(validScore(10)).toBe(true);
    expect(validScore(-3.5)).toBe(true);
    for (const v of [NaN, Infinity, 1e13, "10", null, undefined, {}]) expect(validScore(v)).toBe(false);
  });
});

describe("pixelAvatar", () => {
  it("draws the same avatar for the same seed, mirrored", () => {
    const a = pixelAvatar("levi");
    expect(pixelAvatar("levi")).toEqual(a);
    expect(pixelAvatar("someone")).not.toEqual(a);
    for (const row of a.cells) expect(row).toEqual([...row].reverse());
    expect(a.cells[0].every((c) => !c)).toBe(true);
  });
});

describe("socialErrorKey", () => {
  it("turns server errors into messages", () => {
    expect(socialErrorKey({ message: "rate_limited" })).toBe("soc.err.rateLimited");
    expect(socialErrorKey({ message: "not_member" })).toBe("soc.err.notFriends");
    expect(socialErrorKey({ message: "banned" })).toBe("soc.err.banned");
    expect(socialErrorKey({ message: "something else" })).toBe("error");
  });
});

describe("isOnline", () => {
  it("means seen in the last 5 minutes", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(isOnline("2026-11-10T11:57:00Z", now)).toBe(true);
    expect(isOnline("2026-11-10T11:50:00Z", now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
  });
});
