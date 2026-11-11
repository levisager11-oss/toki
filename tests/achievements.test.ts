import { describe, expect, it } from "vitest";
import {
  achievementProblem, achievementText, addGuestUnlock, cleanIcon, cut, idFromName, MAX_ACHIEVEMENTS, MAX_GUEST_UNLOCKS,
  readAchievements, readGuestUnlocks, sentId, type Achievement,
} from "../src/lib/achievementRules";
import { readTokiJson } from "../src/lib/hostingRules";

const a = (over: Partial<Achievement> = {}): Achievement => ({ id: "first-win", name: "First win", name_de: null, description: "", description_de: null, icon: "🥇", ...over });

describe("a game's achievements", () => {
  it("are read from toki.json or an AI's answer, leaving out what can't be used", () => {
    const list = readAchievements([
      { id: "first-win", name: "  First   win ", name_de: "Erster Sieg", description: "Win a round.", icon: "🥇" },
      { id: "first-win", name: "Again" }, // the same id
      { id: "has space", name: "X" },
      { id: "no-name" },
      { id: "long", name: "x".repeat(60), description: "y".repeat(200), icon: "not one emoji at all" },
      "junk",
      null,
    ]);
    expect(list).toEqual([
      { id: "first-win", name: "First win", name_de: "Erster Sieg", description: "Win a round.", description_de: null, icon: "🥇" },
      { id: "long", name: "x".repeat(40), name_de: null, description: "y".repeat(120), description_de: null, icon: "🏆" },
    ]);
    expect(readAchievements("nope")).toEqual([]);
    expect(readAchievements(Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: "A" })))).toHaveLength(MAX_ACHIEVEMENTS);
  });

  it("come along in toki.json", () => {
    expect(readTokiJson({ achievements: [{ id: "boss", name: "Boss", icon: "👑" }] }).achievements).toEqual([
      { id: "boss", name: "Boss", name_de: null, description: "", description_de: null, icon: "👑" },
    ]);
    expect(readTokiJson({ achievements: [] })).toEqual({});
    expect(readTokiJson({ achievements: "boss" })).toEqual({});
  });

  it("are checked before the form saves them", () => {
    expect(achievementProblem([a(), a({ id: "speedy" })])).toBeNull();
    expect(achievementProblem([a(), a()])).toBe("ach.err.sameId");
    expect(achievementProblem([a({ id: "has space" })])).toBe("ach.err.id");
    expect(achievementProblem([a({ id: "" })])).toBe("ach.err.id");
    expect(achievementProblem([a({ name: "  " })])).toBe("ach.err.name");
    expect(achievementProblem([a({ icon: "two words" })])).toBe("ach.err.icon");
    expect(achievementProblem([a({ icon: "" })])).toBeNull(); // the trophy then
    expect(achievementProblem([a({ icon: "abc" })])).toBe("ach.err.icon");
    expect(achievementProblem(Array.from({ length: 31 }, (_, i) => a({ id: `a${i}` })))).toBe("ach.err.tooMany");
  });

  it("get ids from their names", () => {
    expect(idFromName("First win!", [])).toBe("first-win");
    expect(idFromName("Größter Spass", [])).toBe("grosster-spass");
    expect(idFromName("First win", ["first-win", "first-win-2"])).toBe("first-win-3");
    expect(idFromName("🎉", [])).toBe("achievement");
    expect(idFromName("a".repeat(50), []).length).toBeLessThanOrEqual(32);
  });

  it("keep emoji whole", () => {
    expect(cut("ab👍🏽cd", 3)).toBe("ab👍");
    expect(cleanIcon(" 👨‍👩‍👧 ")).toBe("👨‍👩‍👧");
    expect(cleanIcon("")).toBe("🏆");
    expect(cleanIcon(5)).toBe("🏆");
  });

  it("show in the player's language, German falling back to English", () => {
    expect(achievementText(a({ name_de: "Erster Sieg", description: "Win." }), "de")).toEqual({ name: "Erster Sieg", description: "Win." });
    expect(achievementText(a(), "de").name).toBe("First win");
    expect(achievementText(a({ name_de: "Erster Sieg" }), "en").name).toBe("First win");
  });

  it("only take ids a game can have from the game's messages", () => {
    expect(sentId("first-win")).toBe("first-win");
    expect(sentId("x".repeat(33))).toBeNull();
    expect(sentId(5)).toBeNull();
    expect(sentId("<b>")).toBeNull();
  });
});

describe("unlocks without an account", () => {
  it("are kept once each, newest first, up to a limit", () => {
    let r = addGuestUnlock([], "g1", "a", 1);
    expect(r).toEqual({ list: [{ game: "g1", id: "a", at: 1 }], added: true });
    r = addGuestUnlock(r.list, "g1", "a", 2);
    expect(r.added).toBe(false);
    r = addGuestUnlock(r.list, "g2", "a", 3);
    expect(r.list.map((u) => u.game)).toEqual(["g2", "g1"]);
    const full = Array.from({ length: MAX_GUEST_UNLOCKS }, (_, i) => ({ game: "g", id: `a${i}`, at: i }));
    expect(addGuestUnlock(full, "g", "new", 1).added).toBe(false);
  });

  it("are read back from the browser, leaving out anything broken", () => {
    expect(readGuestUnlocks(JSON.stringify([{ game: "g", id: "a", at: 1 }, { game: "g", id: "bad id", at: 1 }, { game: 1, id: "a", at: 1 }, { game: "g", id: "b" }]))).toEqual([{ game: "g", id: "a", at: 1 }]);
    expect(readGuestUnlocks("{")).toEqual([]);
    expect(readGuestUnlocks(null)).toEqual([]);
  });
});
