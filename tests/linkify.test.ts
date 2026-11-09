import { describe, expect, it } from "vitest";
import { splitLinks } from "../src/components/Linkify";

describe("splitLinks", () => {
  it("finds web addresses in text", () => {
    expect(splitLinks("see https://toki.gg/game/x now")).toEqual([
      { text: "see " }, { text: "https://toki.gg/game/x", href: "https://toki.gg/game/x" }, { text: " now" },
    ]);
  });
  it("leaves punctuation at the end out", () => {
    expect(splitLinks("Go to https://a.dev/x. Then (http://b.dev)!")).toEqual([
      { text: "Go to " }, { text: "https://a.dev/x", href: "https://a.dev/x" }, { text: ". Then (" },
      { text: "http://b.dev", href: "http://b.dev" }, { text: ")!" },
    ]);
  });
  it("keeps brackets that belong to the address", () => {
    const url = "https://en.wikipedia.org/wiki/Tetris_(game)";
    expect(splitLinks(`${url}.`)).toEqual([{ text: url, href: url }, { text: "." }]);
  });
  it("only links http and https", () => {
    expect(splitLinks("javascript:alert(1) ftp://x.y")).toEqual([{ text: "javascript:alert(1) ftp://x.y" }]);
  });
  it("returns plain text unchanged", () => {
    expect(splitLinks("hello")).toEqual([{ text: "hello" }]);
    expect(splitLinks("")).toEqual([]);
  });
});
