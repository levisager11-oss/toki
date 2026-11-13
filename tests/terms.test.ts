import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextTermsApply, TERMS_NEXT_DATE } from "../src/lib/terms";
import { legalDe } from "../src/lib/texts/legalDe";
import { legalEn } from "../src/lib/texts/legalEn";

describe("the announced change to the terms", () => {
  it("applies from midnight Swiss time on its day, by itself", () => {
    expect(TERMS_NEXT_DATE).toBe("2026-11-28");
    expect(nextTermsApply(new Date("2026-11-27T22:59:59Z"))).toBe(false);
    expect(nextTermsApply(new Date("2026-11-27T23:00:00Z"))).toBe(true);
  });

  it("comes at least 14 days after the day it was announced", () => {
    const announced = Date.parse("2026-11-13T00:00:00Z");
    expect((Date.parse(`${TERMS_NEXT_DATE}T00:00:00+01:00`) - announced) / 86_400_000).toBeGreaterThanOrEqual(14);
  });

  it("swaps only the part about reports, in both languages", () => {
    for (const t of [legalEn, legalDe] as Record<string, string>[]) {
      expect(t["legal.terms.body"]).toContain("- {reports}");
      expect(t["legal.terms.reports.now"]).not.toMatch(/\bAI\b|\bKI\b/);
      expect(t["legal.terms.reports.next"]).toMatch(/\bAI\b|\bKI\b/);
      expect(t["legal.terms.coming"]).toContain("{date}");
      expect(t["legal.terms.coming"]).toContain("(/updates)");
    }
  });

  it("is checked on the server before the AI looks at reports", () => {
    const api = readFileSync(join(import.meta.dirname, "..", "api", "assist.ts"), "utf8");
    expect(api).toMatch(/if \(!nextTermsApply\(\)\) return json\(\{ error: "not_yet" \}/);
  });
});
