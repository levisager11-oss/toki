import { describe, expect, it } from "vitest";
import { ageOf, bornValue } from "../src/lib/account";

describe("the age question", () => {
  it("reads the month and year", () => {
    expect(bornValue("2012", "3")).toBe("2012-03");
    expect(bornValue("2012", "12")).toBe("2012-12");
    expect(bornValue("", "3")).toBeNull();
    expect(bornValue("2012", "")).toBeNull();
    expect(bornValue("2012", "13")).toBeNull();
  });

  it("counts a birthday only once its month is over, like the database", () => {
    const now = new Date(2026, 10, 13); // 13 November 2026
    expect(ageOf("2013-10", now)).toBe(13);
    // 13 some day this month: not yet for sure
    expect(ageOf("2013-11", now)).toBe(12);
    expect(ageOf("2013-12", now)).toBe(12);
    expect(ageOf("2010-10", now)).toBe(16);
    expect(ageOf("2010-11", now)).toBe(15);
    // December rolls over into January
    expect(ageOf("2012-12", new Date(2026, 0, 1))).toBe(13);
    expect(ageOf("2012-12", new Date(2025, 11, 31))).toBe(12);
  });
});
