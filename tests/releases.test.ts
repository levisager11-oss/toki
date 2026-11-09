import { describe, expect, it } from "vitest";
import { nextVersion, noteBlocks } from "../src/lib/releases";
import { releaseUrl } from "../src/lib/feedback";

describe("noteBlocks", () => {
  it("turns lines starting with - into a list", () => {
    expect(noteBlocks("The winter update!\n\n- New level\n* Snow\n• Faster sonar\nThanks for playing.")).toEqual([
      { type: "p", text: "The winter update!" },
      { type: "ul", items: ["New level", "Snow", "Faster sonar"] },
      { type: "p", text: "Thanks for playing." },
    ]);
  });
  it("keeps lines of a paragraph together and splits paragraphs at empty lines", () => {
    expect(noteBlocks("one\ntwo\r\n\r\nthree")).toEqual([{ type: "p", text: "one\ntwo" }, { type: "p", text: "three" }]);
  });
  it("starts a new list after a paragraph", () => {
    expect(noteBlocks("- a\ntext\n- b").map((b) => b.type)).toEqual(["ul", "p", "ul"]);
  });
  it("leaves markup as plain text", () => {
    expect(noteBlocks("<b>hi</b>")).toEqual([{ type: "p", text: "<b>hi</b>" }]);
  });
  it("needs a space after the dash", () => expect(noteBlocks("-5 lives")).toEqual([{ type: "p", text: "-5 lives" }]));
  it("returns nothing for empty notes", () => expect(noteBlocks(" \n ")).toEqual([]));
});

describe("nextVersion", () => {
  it.each([["1.2", "1.3"], ["v0.9.4", "v0.9.5"], ["1.9", "1.10"], ["2", "3"], ["1.0-beta", "1.1-beta"], ["Alpha", ""], [undefined, ""]])(
    "%s → %s", (last, next) => expect(nextVersion(last)).toBe(next));
});

describe("releaseUrl", () => {
  it("points at the update on the game's or Toki's updates page", () => {
    const release = { id: "r1", version: "1.2" };
    expect(releaseUrl({ game: { slug: "deep-sub", title: "", created_by: null }, release })).toBe("/game/deep-sub/updates#r-r1");
    expect(releaseUrl({ game: null, release })).toBe("/updates#r-r1");
    expect(releaseUrl({ game: null, release: null })).toBe("");
  });
});
