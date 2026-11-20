import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationGuide } from "../src/lib/integration";
import { devEn } from "../src/lib/texts/devEn";
import { devDe } from "../src/lib/texts/devDe";

// The developer docs (/docs, src/pages/Docs.tsx) explain by hand what the AI instructions
// (src/lib/integration.ts) and the game script (public/toki-save.js) can do.
const root = join(__dirname, "..");
const page = readFileSync(join(root, "src", "pages", "Docs.tsx"), "utf8");
const script = readFileSync(join(root, "public", "toki-save.js"), "utf8");
const blocks = (body: string) => [...body.matchAll(/^\[\[([a-zA-Z]+)\]\]$/gm)].map((m) => m[1]);
const sections = (body: string) => [...body.matchAll(/^## .+? \{#([a-z0-9-]+)\}$/gm)].map((m) => m[1]);

describe("developer docs", () => {
  it("explain every toki call games can make", () => {
    const calls = new Set([
      ...[...integrationGuide("").matchAll(/toki\?\.(\w+)/g)].map((m) => m[1]),
      ...[...script.matchAll(/window\.toki\.(\w+)\s*=/g)].map((m) => m[1]),
    ]);
    expect(calls.size).toBeGreaterThan(4);
    const docs = page + devEn["docs.body"];
    // Add a code example or a line about it to the docs.
    expect([...calls].filter((c) => !new RegExp(`toki\\??\\.${c}\\b`).test(docs))).toEqual([]);
  });

  it("have the same sections and code in English and German", () => {
    expect(sections(devDe["docs.body"])).toEqual(sections(devEn["docs.body"]));
    expect(blocks(devDe["docs.body"])).toEqual(blocks(devEn["docs.body"]));
    for (const name of blocks(devEn["docs.body"])) expect(page).toMatch(new RegExp(`^  ${name}: \\{`, "m"));
  });

  it("have the sections the add-game screen links to", () => {
    const ids = sections(devEn["docs.body"]);
    const linked = [...readFileSync(join(root, "src", "components", "QuickAdd.tsx"), "utf8").matchAll(/anchor="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((id) => !ids.includes(id))).toEqual([]);
  });
});
