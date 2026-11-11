import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app, closureOf, codeFiles, firstDownload, keysUsedBy, laterPages, rel, src, textKeys } from "./textUse";

// Most texts download only with the pages that need them (src/lib/texts/, see page() in
// src/App.tsx). These tests catch a text in a group that a page shows without loading it, which
// would show the key ("form.save") instead of the text.
const i18n = join(src, "lib", "i18n.tsx");
const GROUPS = ["player", "dev", "legal"] as const;
const groupFile = (g: string, lang: "En" | "De") => join(src, "lib", "texts", `${g}${lang}.ts`);
const first = textKeys(i18n, "en");
const groupKeys = Object.fromEntries(GROUPS.map((g) => [g, textKeys(groupFile(g, "En"), `${g}En`)])) as Record<(typeof GROUPS)[number], string[]>;
const allGroupKeys = GROUPS.flatMap((g) => groupKeys[g]);

describe("texts", () => {
  it("are each in one place, in English and German", () => {
    const all = [...first, ...allGroupKeys];
    expect(all.length).toBeGreaterThan(1000);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(textKeys(i18n, "de"))).toEqual(new Set(first));
    for (const g of GROUPS) expect(new Set(textKeys(groupFile(g, "De"), `${g}De`))).toEqual(new Set(groupKeys[g]));
  });

  it("that the first download shows come with it", () => {
    const eager = firstDownload();
    const wrong = [...eager].filter((f) => codeFiles.includes(f)).flatMap((f) => keysUsedBy(f, allGroupKeys).map((k) => `${k} (${rel(f)})`));
    // Move these from src/lib/texts/ into src/lib/i18n.tsx.
    expect(wrong).toEqual([]);
  });

  it("come with each page that loads on demand", () => {
    const pages = laterPages();
    expect(pages.length).toBeGreaterThan(20);
    // Pages load on demand only through page(), which loads their texts.
    const appText = readFileSync(app, "utf8");
    for (const line of appText.split("\n")) if (line.includes("import(")) expect(line).toMatch(/^const \w+ = page\(\(\) => import\("/);
    expect(appText.split("import(").length - 1).toBe(pages.length);

    const eager = firstDownload();
    const wrong: string[] = [];
    for (const p of pages) {
      for (const g of p.groups) expect(GROUPS).toContain(g);
      for (const f of closureOf(p.file)) {
        if (eager.has(f) || !codeFiles.includes(f)) continue;
        for (const g of GROUPS) {
          if (p.groups.includes(g)) continue;
          for (const k of keysUsedBy(f, groupKeys[g])) wrong.push(`${rel(p.file)} needs "${g}" for ${k} (${rel(f)})`);
        }
      }
    }
    // Add the group to the page's page() in src/App.tsx, or move the text into src/lib/i18n.tsx.
    expect(wrong).toEqual([]);
  });

  it("are found where the code uses them", () => {
    // A written-out key, and a built one.
    const card = join(src, "components", "GameCard.tsx");
    expect(keysUsedBy(card, ["cat.action", "home.featured"])).toEqual(["cat.action"]);
    expect(firstDownload().has(join(src, "pages", "GamePage.tsx"))).toBe(true);
    expect(firstDownload().has(join(src, "pages", "GameForm.tsx"))).toBe(false);
  });
});
