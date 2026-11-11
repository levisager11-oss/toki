import { describe, expect, it } from "vitest";
import { currentStreak, dayBefore, formatLeft, msUntilNextDay, msUntilNextWeek, playedToday, utcDay } from "../src/lib/daily";

const at = (iso: string) => new Date(iso);
const H = 3_600_000;

describe("days and weeks (UTC)", () => {
  it("names the day in UTC, whatever the local time", () => {
    expect(utcDay(at("2026-11-27T23:59:59Z"))).toBe("2026-11-27");
    expect(utcDay(at("2026-11-28T00:30:00+02:00"))).toBe("2026-11-27");
  });

  it("knows the day before, also across months and years", () => {
    expect(dayBefore("2026-12-01")).toBe("2026-11-30");
    expect(dayBefore("2027-01-01")).toBe("2026-12-31");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
  });

  it("counts down to midnight UTC", () => {
    expect(msUntilNextDay(at("2026-11-27T00:00:00Z"))).toBe(24 * H);
    expect(msUntilNextDay(at("2026-11-27T18:30:00Z"))).toBe(5.5 * H);
    expect(msUntilNextDay(at("2026-11-27T23:59:59.500Z"))).toBe(500);
  });

  it("counts down to Monday 00:00 UTC", () => {
    // 27 November 2026 is a Friday.
    expect(msUntilNextWeek(at("2026-11-27T12:00:00Z"))).toBe((2 * 24 + 12) * H);
    expect(msUntilNextWeek(at("2026-11-29T23:00:00Z"))).toBe(1 * H); // Sunday night
    expect(msUntilNextWeek(at("2026-11-30T00:00:00Z"))).toBe(7 * 24 * H); // Monday, just started
  });
});

describe("formatLeft", () => {
  it("shows hours and minutes, or days when it's long", () => {
    expect(formatLeft(5 * H + 12 * 60_000 + 30_000, "en")).toBe("5 h 12 min");
    expect(formatLeft(5 * H, "de")).toBe("5 Std.");
    expect(formatLeft(12 * 60_000, "en")).toBe("12 min");
    expect(formatLeft(20_000, "de")).toBe("< 1 Min.");
    expect(formatLeft(-5, "en")).toBe("< 1 min");
    expect(formatLeft(3.5 * 24 * H, "en")).toBe("3 days");
    expect(formatLeft(3.5 * 24 * H, "de")).toBe("3 Tagen");
  });
});

describe("streaks", () => {
  const s = (streak: number, last_day: string) => ({ streak, best_streak: 9, last_day });

  it("stay alive until a whole day is missed", () => {
    expect(currentStreak(s(4, "2026-11-27"), "2026-11-27")).toBe(4);
    expect(currentStreak(s(4, "2026-11-26"), "2026-11-27")).toBe(4);
    expect(currentStreak(s(4, "2026-11-25"), "2026-11-27")).toBe(0);
    expect(currentStreak(null, "2026-11-27")).toBe(0);
    expect(currentStreak(s(2, "2026-11-30"), "2026-12-01")).toBe(2);
  });

  it("know whether today already counted", () => {
    expect(playedToday(s(1, "2026-11-27"), "2026-11-27")).toBe(true);
    expect(playedToday(s(1, "2026-11-26"), "2026-11-27")).toBe(false);
    expect(playedToday(undefined, "2026-11-27")).toBe(false);
  });
});
