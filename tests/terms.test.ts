import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comingTerms, nextTermsApply, TERMS_CHANGES, TERMS_NEXT_DATE, termsApply, termsDate } from "../src/lib/terms";
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

describe("the rules for Toki Tokens", () => {
  it("apply from 5 December, by themselves", () => {
    expect(termsApply("tokens", new Date("2026-12-04T22:59:59Z"))).toBe(false);
    expect(termsApply("tokens", new Date("2026-12-04T23:00:00Z"))).toBe(true);
    expect(termsDate(new Date("2026-11-20T12:00:00Z"))).toBeNull();
    expect(termsDate(new Date("2026-11-30T12:00:00Z"))).toBe("2026-11-28");
    expect(termsDate(new Date("2026-12-05T12:00:00Z"))).toBe("2026-12-05");
    expect(comingTerms(new Date("2026-11-30T12:00:00Z")).map((c) => c.id)).toEqual(["tokens"]);
  });

  it("every change comes at least 14 days after it was announced", () => {
    for (const c of TERMS_CHANGES) {
      // Announced during that day (Swiss time): counted from its very end, to be safe.
      expect((Date.parse(`${c.date}T00:00:00+01:00`) - Date.parse(`${c.announced}T23:59:59+01:00`)) / 86_400_000).toBeGreaterThanOrEqual(14 - 1 / 86_400);
    }
  });

  it("are in both languages, as their own section", () => {
    for (const t of [legalEn, legalDe] as Record<string, string>[]) {
      expect(t["legal.terms.body"]).toContain("{tokens}\n\n## ");
      expect(t["legal.terms.tokens"]).toMatch(/^\n\n## /);
      expect(t["legal.terms.coming.tokens"]).toContain("{date}");
      expect(t["legal.terms.coming.tokens"]).toContain("(/updates)");
    }
  });

  it("trading waits for them in the database too", () => {
    const sql = readFileSync(join(import.meta.dirname, "..", "supabase", "migrations", "20261212090000_toki_tokens.sql"), "utf8");
    expect(sql).toContain("'2026-12-05 00:00:00+01'");
  });
});
