import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { allBoards, boardIdFromName, boardLabel, boardProblem, readBoards, sentBoard } from "../src/lib/boardRules";
import { readTokiJson } from "../src/lib/hostingRules";
import { gameUpdate, updateInstructions } from "../src/lib/gameUpdates";
import { boardsLine, gameLine, proposed, uploadFeatures, type Job } from "../server/connect/agent";

describe("a game's boards", () => {
  it("are read from toki.json: checked, cut, at most 10 plus the main one's name", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, name: `B ${i}` }));
    expect(readBoards([{ id: "", name: " Normal ", name_de: "Normal" }, { id: "", name: "Again" }, ...many])).toHaveLength(11);
    expect(readBoards([
      { id: "hard", name: "Hard   mode", name_de: "Schwer", score_order: "high", score_format: "points" },
      { id: "speedrun", name: "Speedrun", score_order: "low", score_format: "time" },
      { id: "x", name: "No order", score_order: "up", score_format: "meters" },
      { id: "hard", name: "Twice" }, { id: "bad id", name: "Bad" }, { id: "nameless" }, { id: "", name: "" }, "nope", null,
      { id: "long", name: "y".repeat(60) },
    ])).toEqual([
      { id: "hard", name: "Hard mode", name_de: "Schwer", score_order: "high", score_format: "points" },
      { id: "speedrun", name: "Speedrun", name_de: null, score_order: "low", score_format: "time" },
      // An order or format that isn't right stays out, so the one on Toki stays.
      { id: "x", name: "No order", name_de: null },
      { id: "long", name: "y".repeat(40), name_de: null },
    ]);
    expect(readBoards("hard")).toEqual([]);
    expect(readTokiJson({ boards: [{ id: "hard", name: "Hard" }] }).boards).toEqual([{ id: "hard", name: "Hard", name_de: null }]);
    expect(readTokiJson({ boards: [] }).boards).toBeUndefined();
  });

  it("are checked in the form", () => {
    expect(boardProblem([{ id: "hard", name: "Hard" }])).toBeNull();
    expect(boardProblem(Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, name: "B" })))).toBe("boards.err.tooMany");
    expect(boardProblem([{ id: "has space", name: "A" }])).toBe("boards.err.id");
    expect(boardProblem([{ id: "", name: "A" }])).toBe("boards.err.id");
    expect(boardProblem([{ id: "a", name: "A" }, { id: "a", name: "B" }])).toBe("boards.err.sameId");
    expect(boardProblem([{ id: "a", name: " " }])).toBe("boards.err.name");
    expect(boardIdFromName("Hard mode!", [])).toBe("hard-mode");
    expect(boardIdFromName("Straße", ["strasse"])).toBe("strasse-2");
    expect(boardIdFromName("!!!", [])).toBe("board");
  });

  it("start with the main one, named as the developer said or “Main”", () => {
    const extra = [{ id: "hard", name: "Hard", name_de: "Schwer", score_order: "low" as const, score_format: "time" as const }];
    const list = allBoards({ score_order: "high", score_format: "points" }, extra);
    expect(list.map((b) => b.id)).toEqual(["", "hard"]);
    expect(boardLabel(list[0], "en", "Main")).toBe("Main");
    expect(boardLabel(allBoards({ board_name: "Classic", board_name_de: "Klassisch" }, [])[0], "de", "Hauptliste")).toBe("Klassisch");
    expect(boardLabel(list[1], "de", "Hauptliste")).toBe("Schwer");
    expect(boardLabel({ id: "hard", name: "Hard", name_de: null }, "de", "Hauptliste")).toBe("Hard");
  });

  it("take scores sent to them, and nothing that can't be an id", () => {
    expect(sentBoard(undefined)).toBe("");
    expect(sentBoard("")).toBe("");
    expect(sentBoard("hard")).toBe("hard");
    expect(sentBoard(2)).toBe("2");
    expect(sentBoard("bad id")).toBeNull();
    expect(sentBoard({})).toBeNull();
  });
});

describe("the game script", () => {
  async function load() {
    const src = await readFile(new URL("../public/toki-save.js", import.meta.url), "utf8");
    const sent: unknown[] = [];
    const top = { postMessage: (m: unknown) => sent.push(m) };
    const win: Record<string, unknown> = { localStorage: { length: 0, getItem: () => null, key: () => null }, addEventListener() {} };
    win.parent = top;
    const doc = { referrer: "https://www.playtoki.app/game/apex", hidden: false, addEventListener() {} };
    new Function("window", "location", "document", "Storage", "setTimeout", src)(win, { ancestorOrigins: [] }, doc, { prototype: { setItem() {}, removeItem() {}, clear() {} } }, () => 0);
    sent.length = 0; // the "hello"
    return { toki: win.toki as { score(n: unknown, board?: unknown): void }, sent, src };
  }

  it("is v8, and sends scores to the main list or to another one", async () => {
    const { toki, sent, src } = await load();
    expect(src.startsWith("/* Toki save support v8.")).toBe(true);
    toki.score(10);
    toki.score(20, "hard");
    toki.score(30, "");
    toki.score(40, 3);
    toki.score(50, null);
    toki.score(NaN, "hard");
    toki.score("60", "hard");
    expect(sent).toEqual([
      { toki: 1, type: "score", data: 10 },
      { toki: 1, type: "score", data: 20, board: "hard" },
      { toki: 1, type: "score", data: 30 },
      { toki: 1, type: "score", data: 40, board: "3" },
      { toki: 1, type: "score", data: 50 },
    ]);
  });
});

describe("Toki Connect and boards", () => {
  const job = (over: Partial<Job> = {}): Job => ({
    id: "j", repo: "me/run", features: ["boards"], notes: "", status: "working", messages: [], state: {},
    game: { title: "Run", score_order: "high", score_format: "points" }, ...over,
  });
  const withBoards = job({ game: { title: "Run", score_order: "high", score_format: "points", boards: [{ id: "speedrun", name: "Speedrun", score_order: "low", score_format: "time" }] } });

  it("may be asked for", () => {
    expect(uploadFeatures(["boards", "ladders"])).toEqual(["boards"]);
  });

  it("tells the AI the game's boards, or to propose some", () => {
    expect(boardsLine(withBoards)).toContain("- speedrun: Speedrun, lower is better, a time in milliseconds");
    expect(boardsLine(withBoards)).toContain('toki.score(points, "id")');
    // A high-score run on a game with boards hears about them too.
    expect(gameLine({ ...withBoards, features: ["scores"] })).toContain("- speedrun");
    expect(boardsLine({ ...withBoards, features: ["saves"] })).toBe("");
    expect(boardsLine(job())).toContain("no other high-score lists on Toki yet");
    expect(boardsLine(job({ features: ["scores"] }))).toBe("");
  });

  it("takes the boards the AI proposed only for a game that has none", () => {
    const answer = { boards: [{ id: "hard", name: "Hard" }, { id: "", name: "Renamed" }, { id: "bad id", name: "X" }] };
    expect(proposed(job(), answer)).toEqual({ boards: [{ id: "hard", name: "Hard", name_de: null }] });
    expect(proposed(withBoards, answer)).toEqual({});
    expect(proposed(job({ features: ["scores"] }), answer)).toEqual({});
    expect(proposed(job(), undefined)).toEqual({});
  });

  it("has an update for developers' games that explains toki.score with a board", () => {
    const u = gameUpdate("boards")!;
    expect(u.feature).toBe("boards");
    expect(u.applies({ multiplayer: false })).toBe(true);
    const text = updateInstructions(u, "/* script */");
    expect(text).toContain('window.toki?.score(points, "id")');
    expect(text).toContain('"boards": [');
    expect(u.only).toContain("More lists");
  });
});
