import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_KEEP, DEFAULT_LIMITS, RATE_ERRORS, fillLimits, limitErrorKey, setLimitValues } from "../src/lib/limitValues";
import { format } from "../src/lib/i18n";
import { textKeys } from "./textUse";

const ROOT = join(import.meta.dirname, "..");
const migration = readFileSync(join(ROOT, "supabase", "migrations", "20261130090000_admin_limits.sql"), "utf8");
const i18n = join(ROOT, "src", "lib", "i18n.tsx");
const dev = (lang: "En" | "De") => join(ROOT, "src", "lib", "texts", `dev${lang}.ts`);

afterEach(() => setLimitValues({ limits: {}, keep: {} }));

describe("limits in texts", () => {
  it("fills in numbers and picks the form for them", () => {
    expect(fillLimits("Up to {limit.group_size} people")).toBe("Up to 20 people");
    expect(fillLimits("Deleted after {keep.chat_public|# day|# days}.")).toBe("Deleted after 7 days.");
    setLimitValues({ limits: { ideas_day: 1 }, keep: { chat_public: 1 } });
    expect(fillLimits("You can propose {limit.ideas_day|# game|# games} a day")).toBe("You can propose 1 game a day");
    expect(fillLimits("after {keep.chat_public|# Tag|# Tagen}")).toBe("after 1 Tag");
    expect(fillLimits("{limit.nope} stays")).toBe("{limit.nope} stays");
  });

  it("shows admins (no limit) the players' number", () => {
    setLimitValues({ limits: { ideas_day: null }, keep: {} });
    expect(fillLimits("{limit.ideas_day}")).toBe("3");
  });

  it("works next to the other placeholders", () => {
    setLimitValues({ limits: { party_size: 5 }, keep: {} });
    expect(format("{name}: full ({limit.party_size} players)", { name: "Party" })).toBe("Party: full (5 players)");
  });

  it("names the limit from the database's error", () => {
    expect(limitErrorKey("rate_limited:ideas_day")).toBe("limit.err.ideas_day");
    expect(limitErrorKey("rate_limited")).toBeNull();
    expect(limitErrorKey("rate_limited:storage_mb")).toBeNull();
  });
});

describe("limits match the database", () => {
  const rows = (table: string) => {
    const start = migration.indexOf(`insert into public.${table}`);
    const block = migration.slice(start, migration.indexOf(";", start));
    return [...block.matchAll(/\('([a-z0-9_]+)',\s*([^)]*)\)/g)].map((m) => [m[1], m[2].split(",").map((x) => x.trim())] as const);
  };

  it("has the same defaults", () => {
    const limits = rows("limits");
    expect(limits.map(([k]) => k).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
    for (const [k, [, player]] of limits) expect(Number(player), k).toBe(DEFAULT_LIMITS[k as keyof typeof DEFAULT_LIMITS]);
    const keep = rows("keep_times");
    expect(keep.map(([k]) => k).sort()).toEqual(Object.keys(DEFAULT_KEEP).sort());
    for (const [k, [value]] of keep) expect(Number(value), k).toBe(DEFAULT_KEEP[k as keyof typeof DEFAULT_KEEP]);
  });

  it("names in errors only limits the database raises that way", () => {
    for (const k of RATE_ERRORS) expect(migration, k).toContain(`check_limit(v_me, '${k}'`.replace("v_me", k === "applications_month" ? "auth.uid()" : "v_me"));
  });

  it("has every text, in English and German", () => {
    for (const lang of ["en", "de"] as const) {
      const first = new Set(textKeys(i18n, lang));
      for (const k of RATE_ERRORS) expect(first.has(`limit.err.${k}`), `limit.err.${k} (${lang})`).toBe(true);
      const admin = new Set(textKeys(dev(lang === "en" ? "En" : "De"), lang === "en" ? "devEn" : "devDe"));
      for (const k of Object.keys(DEFAULT_LIMITS)) {
        const key = k.startsWith("ai_") ? `ai.free.feature.${k.slice(3)}` : `lim.k.${k}`;
        expect(admin.has(key), `${key} (${lang})`).toBe(true);
      }
      for (const k of Object.keys(DEFAULT_KEEP)) expect(admin.has(`lim.keep.${k}`), `lim.keep.${k} (${lang})`).toBe(true);
      for (let g = 1; g <= 7; g++) expect(admin.has(`lim.group.${g}`), `lim.group.${g} (${lang})`).toBe(true);
    }
  });
});
