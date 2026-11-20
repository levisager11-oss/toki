import { describe, expect, it } from "vitest";
import { onScreen, tokenUsable } from "../src/lib/analytics";

const token = (payload: object) => {
  const part = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "HS256" })}.${part(payload)}.signature`;
};
const NOW = Date.parse("2026-11-20T08:45:00Z");

describe("the login token playtime is sent with", () => {
  it("is used while it lasts", () => {
    expect(tokenUsable(token({ exp: NOW / 1000 + 3600 }), NOW)).toBe(true);
    // Padding and the URL alphabet don't matter.
    expect(tokenUsable(token({ exp: NOW / 1000 + 3600, name: "ÿ?>~" }), NOW)).toBe(true);
  });
  it("is left out once it is over, or about to be", () => {
    // The computer slept: the login ended in the night and wasn't renewed yet.
    expect(tokenUsable(token({ exp: NOW / 1000 - 6 * 3600 }), NOW)).toBe(false);
    expect(tokenUsable(token({ exp: NOW / 1000 + 5 }), NOW)).toBe(false);
  });
  it("is left out when there is none, or it can't be read", () => {
    expect(tokenUsable(undefined, NOW)).toBe(false);
    expect(tokenUsable("", NOW)).toBe(false);
    expect(tokenUsable("not-a-token", NOW)).toBe(false);
    expect(tokenUsable(token({ sub: "x" }), NOW)).toBe(false);
  });
});

describe("time on screen", () => {
  it("counts as it is", () => {
    expect(onScreen(1500)).toBe(1500);
    expect(onScreen(10 * 60_000)).toBe(10 * 60_000);
  });
  it("doesn't count a night the computer slept through", () => {
    expect(onScreen(8 * 3_600_000)).toBe(10 * 60_000);
    expect(onScreen(-5)).toBe(0);
  });
});
