import { describe, expect, it } from "vitest";
import { IDLE_MS, IDLE_UNSEEN_MS, onScreen, playedIn, tokenUsable } from "../src/lib/analytics";
import { readFileSync } from "node:fs";

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

describe("time with nobody playing", () => {
  const MIN = 60_000;
  it("counts while there is input", () => {
    expect(playedIn(0, 4 * MIN, 3 * MIN, IDLE_MS)).toBe(4 * MIN);
  });
  it("stops a few minutes after the last input", () => {
    // Last input at 1 min: counts up to 6 min, not the 10 since.
    expect(playedIn(0, 10 * MIN, 1 * MIN, IDLE_MS)).toBe(6 * MIN);
    // Nothing at all after that.
    expect(playedIn(10 * MIN, 20 * MIN, 1 * MIN, IDLE_MS)).toBe(0);
  });
  it("waits longer for games that don't say when there was input", () => {
    expect(IDLE_UNSEEN_MS).toBeGreaterThan(IDLE_MS);
    expect(playedIn(0, 10 * MIN, 1 * MIN, IDLE_UNSEEN_MS)).toBe(10 * MIN);
    expect(playedIn(40 * MIN, 50 * MIN, 1 * MIN, IDLE_UNSEEN_MS)).toBe(0);
  });
  it("still doesn't count a night the computer slept through", () => {
    expect(playedIn(0, 8 * 3_600_000, 8 * 3_600_000, IDLE_MS)).toBe(10 * MIN);
  });
  it("is told by the save script when there was input in the game", () => {
    const script = readFileSync("public/toki-save.js", "utf8");
    expect(script).toContain('type: "inputs"');
    expect(script).toContain('type: "active"');
  });
});
