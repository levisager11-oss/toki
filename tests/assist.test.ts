import { describe, expect, it } from "vitest";
import {
  plain, readDescribe, readRelease, readSimilar, readSuggest, readTranslation, releasePrompt, similarPrompt, suggestPrompt, translatePrompt,
} from "../server/assist/prompts";
import { linksIn, pageText, readPage } from "../server/assist/pages";

describe("translations", () => {
  it("ask for every text in order, in Swiss German spelling", () => {
    const [system, user] = translatePrompt(["Hello", "World"], "de");
    expect(system.content).toContain("German");
    expect(system.content).toContain("ss");
    expect(JSON.parse(user.content)).toEqual(["Hello", "World"]);
    expect(translatePrompt(["Hallo"], "en")[0].content).not.toContain("„");
  });

  it("are used only when there's one for each text", () => {
    expect(readTranslation('<think>{"x":1}</think>{"t":["Hallo","Welt"]}', ["Hello", "World"])).toEqual(["Hallo", "Welt"]);
    expect(readTranslation('```json\n{"t":["Hallo"]}\n```', ["Hello"])).toEqual(["Hallo"]);
    expect(readTranslation('{"t":["Hallo"]}', ["Hello", "World"])).toBeNull();
    expect(readTranslation('{"t":["", "Welt"]}', ["Hello", "World"])).toBeNull();
    expect(readTranslation("Hallo Welt", ["Hello World"])).toBeNull();
  });
});

describe("similar feedback", () => {
  const list = [
    { id: "a", kind: "bug", title: "Game freezes on level 3", body: "" },
    { id: "b", kind: "idea", title: "Add a dark mode", body: "please" },
  ];

  it("numbers the existing posts and names the new one", () => {
    const [, user] = similarPrompt({ kind: "bug", title: "Stuck at level 3", body: "It stops" }, list);
    expect(user.content).toContain("1. [bug] Game freezes on level 3");
    expect(user.content).toContain("2. [idea] Add a dark mode — please");
    expect(user.content).toContain("[bug] Stuck at level 3");
  });

  it("only returns posts from the list, at most 3", () => {
    expect(readSimilar('{"same":[1]}', list)).toEqual(["a"]);
    expect(readSimilar('{"same":[2, 1, 2, 7, "x"]}', list)).toEqual(["b", "a"]);
    expect(readSimilar('{"same":[]}', list)).toEqual([]);
    expect(readSimilar("none", list)).toEqual([]);
  });
});

describe("release note drafts", () => {
  it("use the notes, fixed feedback and commits, and never invent", () => {
    const [system, user] = releasePrompt({ game: "Run", lang: "en", notes: "new level", fixes: [{ kind: "bug", title: "Jump bug" }], commits: ["Add level 4", "ci: cache"], lastVersion: "1.2" });
    expect(system.content).toContain("never invent");
    expect(user.content).toContain("new level");
    expect(user.content).toContain("[bug] Jump bug");
    expect(user.content).toContain("- Add level 4");
    expect(user.content).toContain("version 1.2");
  });

  it("make every change a list line", () => {
    expect(readRelease('{"title":"Level 4 is here","notes":"* New level\\n• Fixed: jumping\\nThanks!"}')).toEqual({
      title: "Level 4 is here",
      notes: "- New level\n- Fixed: jumping\nThanks!",
    });
    expect(readRelease('{"title":"x","notes":""}')).toBeNull();
  });
});

describe("game descriptions", () => {
  it("need both languages", () => {
    expect(readDescribe('{"en":"Jump and run.","de":"Spring und renn."}')).toEqual({ en: "Jump and run.", de: "Spring und renn." });
    expect(readDescribe('{"en":"Jump and run."}')).toBeNull();
  });
});

describe("game suggestions", () => {
  const games = [
    { id: "1", slug: "a", title: "A", category: "arcade", description: "" },
    { id: "2", slug: "b", title: "B", category: "puzzle", description: "Think" },
  ];

  it("list the liked and played games and the ones to pick from", () => {
    const [, user] = suggestPrompt([games[0]], [], [games[1]], "de");
    expect(user.content).toContain("liked:\n- A (arcade)");
    expect(user.content).toContain("1. B (puzzle): Think");
  });

  it("only pick from the list, once each, at most 4", () => {
    expect(readSuggest('{"picks":[{"n":2,"why":"Puzzles"},{"n":2},{"n":9},{"n":1,"why":"x"}]}', games)).toEqual([
      { id: "2", slug: "b", why: "Puzzles" },
      { id: "1", slug: "a", why: "x" },
    ]);
  });
});

describe("plain answers", () => {
  it("lose code fences and thinking", () => expect(plain("<think>hmm</think>\n```\n- One\n```", 100)).toBe("- One"));
});

describe("reading web pages", () => {
  it("takes the title, description and visible text", () => {
    const p = pageText('<html><head><title>My &amp; Game</title><meta name="description" content="A jump game"><style>x{}</style></head><body><script>evil()</script><h1>Play</h1></body></html>');
    expect(p).toEqual({ title: "My & Game", text: "A jump game\nMy & Game Play" });
  });

  it("finds https links in a text", () => {
    expect(linksIn("See https://a.example/game. And http://b.example and https://a.example/game")).toEqual(["https://a.example/game"]);
  });

  it("never opens local or private addresses, also not after a redirect", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    }) as unknown as typeof fetch;
    expect(await readPage("https://localhost/x", f)).toMatchObject({ ok: false });
    expect(await readPage("https://game.example/", f)).toMatchObject({ ok: false });
    expect(calls).toEqual(["https://game.example/"]);
  });
});
