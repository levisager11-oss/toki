import { describe, expect, it } from "vitest";
import { basics, gameFolder, readScan, withToki } from "../server/assist/scan";
import { prompt } from "../server/connect/agent";

const page = `<html><head><title>Moon Hop</title></head><body><canvas></canvas><script src="game.js"></script></body></html>`;
const code = `let score = 0; function gameOver() { showScore(score); }`;

describe("reading a game for one-click add", () => {
  it("finds what simple checks can tell", () => {
    const p = basics([{ path: "index.html", text: page }, { path: "game.js", text: code }], "moon-hop.zip");
    expect(p).toMatchObject({ title: "Moon Hop", leaderboard: true, has_scores: false, score_order: "high", score_format: "points", isolation: false });
  });

  it("uses the upload's name when the page title says nothing, and spots time games and Godot threads", () => {
    const godot = `<title>Godot</title><script>const GODOT_THREADS_ENABLED = true; engine.startGame()</script>`;
    const p = basics([{ path: "index.html", text: godot }, { path: "a.js", text: "let bestTime = timer.elapsed" }], "speed_run.zip");
    expect(p).toMatchObject({ title: "Speed Run", engine: "Godot", isolation: true, score_order: "low", score_format: "time" });
  });

  it("knows games that send scores already", () => {
    expect(basics([{ path: "index.html", text: page + "<script>toki.score(5)</script>" }], "x").has_scores).toBe(true);
  });

  it("takes the AI's proposal, but only valid values", () => {
    const base = basics([{ path: "index.html", text: page }], "x");
    const p = readScan(JSON.stringify({ title: "Moon Hop!", description: "Hop.", description_de: "Hüpf.", category: "Platformer", controls: "Space", leaderboard: false, score_order: "sideways" }), base);
    expect(p).toMatchObject({ title: "Moon Hop!", description: "Hop.", description_de: "Hüpf.", category: "platformer", controls: "Space", leaderboard: false, score_order: "high" });
    expect(readScan("not json", base)).toEqual(base);
    expect(readScan(JSON.stringify({ category: "cooking" }), base).category).toBe("other");
  });

  it("lets a toki.json win", () => {
    const base = basics([{ path: "index.html", text: page }], "x");
    expect(withToki(base, { title: "Official", controls: "WASD" })).toMatchObject({ title: "Official", controls: "WASD" });
  });
});

describe("finding the game in a repository", () => {
  const read = (files: Record<string, string>) => (p: string) => files[p];

  it("takes the folder with a playable index.html", () => {
    expect(gameFolder(["index.html", "game.js"], read({ "index.html": page }))).toEqual({ folder: "", needsBuild: false });
    expect(gameFolder(["src/index.html", "docs/index.html"], read({ "docs/index.html": page }))).toEqual({ folder: "docs", needsBuild: false });
  });

  it("knows a bundler's source page needs building first", () => {
    const vite = `<div id="app"></div><script type="module" src="/src/main.ts"></script>`;
    expect(gameFolder(["index.html", "package.json", "src/main.ts"], read({ "index.html": vite, "package.json": '{"scripts":{"build":"vite build"}}' }))).toEqual({ folder: null, needsBuild: true });
    // …unless the built game is in the repository too
    expect(gameFolder(["index.html", "dist/index.html", "package.json"], read({ "index.html": vite, "dist/index.html": page, "package.json": '{"scripts":{"build":"vite build"}}' }))).toEqual({ folder: "dist", needsBuild: false });
  });

  it("says when there's nothing to play", () => {
    expect(gameFolder(["README.md"], read({}))).toEqual({ folder: null, needsBuild: false });
  });
});

describe("Toki Connect on an uploaded game", () => {
  it("tells the AI its change goes live, and that the save script is there already", () => {
    const job = { id: "j", repo: "toki/moon-hop", source: "upload" as const, features: ["scores" as const], notes: "", status: "working" as const, messages: [], state: {} };
    const [system, user] = prompt(job, { branch: "live", paths: ["index.html"], files: {} }, [], "/* script */");
    expect(system.content).toContain("live as the game's next version");
    expect(system.content).toContain("don't add the script tag");
    expect(system.content).toContain('answer "impossible"');
    expect(user.content).toContain("The game's files on Toki");
    expect(user.content).not.toContain("toki/moon-hop");
  });
});
