import { describe, expect, it } from "vitest";
import { format } from "../src/lib/i18n";
import { compact, matches, slugify, sortGames } from "../src/lib/games";
import { recentlyUpdated } from "../src/lib/releases";
import type { Game } from "../src/lib/types";
import { isNew } from "../src/components/GameCard";
import { isUnseen } from "../src/lib/whatsNew";

const game = (over: Partial<Game> = {}): Game => ({
  id: "1", slug: "deep-sub", title: "Deep Sub", description: "", description_de: null, controls: "", controls_de: null,
  category: "action", engine: "Godot", play_url: "https://x.dev", thumbnail_url: null, cover: null,
  featured: false, created_by: null, created_at: "", updated_at: "", screenshots: [],
  author: { username: "levi_22" }, stats: null, ...over,
});

describe("format", () => {
  it("fills placeholders", () => expect(format("Hi {name}, {name}!", { name: "Levi" })).toBe("Hi Levi, Levi!"));
  it("picks singular and plural", () => {
    expect(format("{n} play|{n} plays", { n: 1 })).toBe("1 play");
    expect(format("{n} play|{n} plays", { n: 0 })).toBe("0 plays");
    expect(format("{n} play|{n} plays", { n: 12 })).toBe("12 plays");
  });
});

describe("compact", () => {
  it.each([[0, "0"], [999, "999"], [1000, "1k"], [1250, "1.3k"], [12_400, "12k"], [1_000_000, "1M"], [2_350_000, "2.4M"]])("%i → %s", (n, s) =>
    expect(compact(n)).toBe(s));
});

describe("matches", () => {
  it("ignores case for title, author and engine", () => {
    expect(matches(game(), "DEEP", "Action")).toBe(true);
    expect(matches(game(), "Levi", "Action")).toBe(true);
    expect(matches(game(), "godot", "Action")).toBe(true);
    expect(matches(game(), "action", "Action")).toBe(true);
    expect(matches(game(), "racing", "Action")).toBe(false);
  });
  it("matches everything for an empty search", () => expect(matches(game(), "  ", "Action")).toBe(true));
  it("works without an author", () => expect(matches(game({ author: null }), "levi", "Action")).toBe(false));
  it("searches the description in both languages", () => {
    expect(matches(game({ description: "Dive into the ocean" }), "ocean", "Action")).toBe(true);
    expect(matches(game({ description_de: "Tauche ins Meer" }), "meer", "Action")).toBe(true);
  });
  it("needs every word, in any order", () => {
    expect(matches(game(), "sub deep", "Action")).toBe(true);
    expect(matches(game(), "deep racing", "Action")).toBe(false);
  });
  it("ignores accents", () => {
    expect(matches(game({ title: "Über Höhlen" }), "uber hohlen", "Action")).toBe(true);
    expect(matches(game(), "déep", "Action")).toBe(true);
  });
});

describe("slugify", () => {
  it("makes page addresses", () => {
    expect(slugify("Über Cool Game!")).toBe("uber-cool-game");
    expect(slugify("  --a  b--  ")).toBe("a-b");
    expect(slugify("x".repeat(50))).toHaveLength(40);
  });
});

describe("isNew", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  it("is new for two weeks", () => {
    expect(isNew(game({ created_at: "2026-11-10T12:00:00Z" }), now)).toBe(true);
    expect(isNew(game({ created_at: "2026-11-01T12:00:00Z" }), now)).toBe(false);
  });
  it("is not new without a date", () => expect(isNew(game({ created_at: "" }), now)).toBe(false));
});

describe("isUnseen", () => {
  it("is only new when newer than what was seen", () => {
    expect(isUnseen("2026-11-09T12:00:00Z", "2026-11-08T12:00:00Z")).toBe(true);
    expect(isUnseen("2026-11-09T12:00:00Z", "2026-11-09T12:00:00Z")).toBe(false);
    expect(isUnseen("2026-11-09T12:00:00Z", null)).toBe(false);
    expect(isUnseen(null, "2026-11-09T12:00:00Z")).toBe(false);
  });
});

describe("sortGames", () => {
  const a = game({ id: "a", title: "A", created_at: "2026-11-01T00:00:00Z", stats: { plays: 5, likes: 1 } });
  const b = game({ id: "b", title: "B", created_at: "2026-10-01T00:00:00Z", stats: { plays: 9, likes: 1 } });
  const c = game({ id: "c", title: "C", created_at: "2026-09-01T00:00:00Z", stats: { plays: 1, likes: 4 } });
  const titles = (list: Game[]) => list.map((g) => g.title).join("");
  it("keeps the newest first", () => expect(titles(sortGames([a, b, c], "new"))).toBe("ABC"));
  it("sorts by plays and likes", () => {
    expect(titles(sortGames([a, b, c], "popular"))).toBe("BAC");
    expect(titles(sortGames([a, b, c], "liked"))).toBe("CBA");
  });
  it("sorts by the last posted update, else by when the game was added", () => {
    const updates = new Map([["c", "2026-11-05T00:00:00Z"]]);
    expect(titles(sortGames([a, b, c], "updated", updates))).toBe("CAB");
  });
});

describe("recentlyUpdated", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("is true for updates in the last 7 days", () => {
    expect(recentlyUpdated("2026-11-05T12:00:00Z", now)).toBe(true);
    expect(recentlyUpdated("2026-10-30T12:00:00Z", now)).toBe(false);
    expect(recentlyUpdated(undefined, now)).toBe(false);
  });
});
