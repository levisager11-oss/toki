import { describe, expect, it } from "vitest";
import { groupReleases, wholeVersions, nextSmallVersion, nextVersion, noteBlocks, type Release } from "../src/lib/releases";
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

const rel = (version: string, small = false) => ({ id: version, version, small }) as Release;

describe("groupReleases", () => {
  it("puts small updates under the main version they follow", () => {
    const g = groupReleases([rel("1.3"), rel("1.2.2", true), rel("1.2.1", true), rel("1.2"), rel("1.1")]);
    expect(g.map((x) => [x.main?.version, x.small.map((r) => r.version)])).toEqual([
      ["1.3", []], ["1.2", ["1.2.2", "1.2.1"]], ["1.1", []],
    ]);
  });
  it("keeps small updates that are newer than the latest main version with it", () => {
    const g = groupReleases([rel("1.2.1", true), rel("1.2")]);
    expect(g).toHaveLength(1);
    expect(g[0].main?.version).toBe("1.2");
  });
  it("lists small updates without any main version on their own", () => {
    expect(groupReleases([rel("0.0.1", true)])).toEqual([{ main: null, small: [rel("0.0.1", true)] }]);
    expect(groupReleases([])).toEqual([]);
  });
  it("puts small updates older than every main version last", () => {
    const g = groupReleases([rel("1.3"), rel("1.2.1", true)]);
    expect(g.map((x) => x.main?.version ?? null)).toEqual(["1.3", null]);
  });
});

describe("wholeVersions", () => {
  const page = [rel("1.3"), rel("1.2.2", true), rel("1.2.1", true)];
  it("drops small updates whose main version is on the next page", () =>
    expect(wholeVersions(page, true).map((r) => r.version)).toEqual(["1.3"]));
  it("keeps everything on the last page", () => expect(wholeVersions(page, false)).toEqual(page));
  it("keeps a page that holds only small updates", () => {
    const smalls = [rel("1.2.2", true), rel("1.2.1", true)];
    expect(wholeVersions(smalls, true)).toEqual(smalls);
  });
});

describe("nextSmallVersion", () => {
  it("counts up from the latest main version", () => {
    expect(nextSmallVersion([rel("1.2"), rel("1.1")])).toBe("1.2.1");
    expect(nextSmallVersion([rel("1.2.1", true), rel("1.2")])).toBe("1.2.2");
    expect(nextSmallVersion([rel("1.3"), rel("1.2.1", true), rel("1.2")])).toBe("1.3.1");
  });
  it("skips versions that are taken", () => expect(nextSmallVersion([rel("1.2.2", true), rel("1.2")])).toBe("1.2.3"));
  it("has no guess without a main version", () => expect(nextSmallVersion([rel("0.0.1", true)])).toBe(""));
});

describe("releaseUrl", () => {
  it("points at the update on the game's or Toki's updates page", () => {
    const release = { id: "r1", version: "1.2" };
    expect(releaseUrl({ game: { slug: "deep-sub", title: "", created_by: null }, release })).toBe("/game/deep-sub/updates#r-r1");
    expect(releaseUrl({ game: null, release })).toBe("/updates#r-r1");
    expect(releaseUrl({ game: null, release: null })).toBe("");
  });
});
