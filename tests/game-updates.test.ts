import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GAME_UPDATES, gameUpdate, isDone, ownConnection, updateConnectPath, updateInstructions, updateKeys, updateState, type GameUpdate } from "../src/lib/gameUpdates";
import type { ConnectJob } from "../src/lib/ai";
import { uploadFeatures } from "../server/connect/agent";

const i18n = readFileSync(new URL("../src/lib/i18n.tsx", import.meta.url), "utf8");
const host = gameUpdate("host")!;
const job = (over: Partial<ConnectJob>): ConnectJob => ({
  id: "j", repo: "dev/game", features: ["multiplayer"], notes: "", status: "done", messages: [], pr_url: null, error: null, error_detail: null,
  game_id: "g1", feedback_id: null, engine: "steps", source: "github", created_at: "2026-11-12T10:00:00Z", updated_at: "2026-11-12T10:05:00Z", ...over,
});

describe("updates for developers' games", () => {
  it("each have a topic the database takes, a day, and their texts in both languages", () => {
    expect(GAME_UPDATES.length).toBeGreaterThan(0);
    expect(new Set(GAME_UPDATES.map((u) => u.topic)).size).toBe(GAME_UPDATES.length);
    for (const u of GAME_UPDATES) {
      expect(u.topic).toMatch(/^[a-z][a-z0-9_]{0,29}$/); // notify_developers' rule
      // A moment, not a day: runs from earlier that day didn't know about the update.
      expect(u.since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/);
      expect(Number.isNaN(new Date(u.since).getTime())).toBe(false);
      expect(u.only.length).toBeGreaterThan(20);
      // Once in English and once in German.
      for (const key of Object.values(updateKeys(u.topic))) expect(i18n.split(`"${key}":`).length - 1).toBe(2);
    }
  });

  it("are for the games they change something in", () => {
    expect(host.applies({ multiplayer: true })).toBe(true);
    expect(host.applies({ multiplayer: false })).toBe(false);
    expect(host.applies({})).toBe(false);
    expect(gameUpdate("nothing")).toBeUndefined();
    expect(gameUpdate(undefined)).toBeUndefined();
  });

  it("come with instructions that say what to add this time", () => {
    const text = updateInstructions(host, "/* script */");
    expect(text).toContain("window.toki?.onHost(fn)"); // the guide explains it
    expect(text).toContain("/* script */"); // and brings the current script
    expect(text.trimEnd().endsWith(host.only)).toBe(true);
    expect(host.only).toContain("toki.onHost");
  });
});

describe("where a game stands with an update", () => {
  const state = (jobs: ConnectJob[], update: GameUpdate = host, repo: string | null = null) => updateState(update, { id: "g1", repo }, jobs).state;

  it("follows the developer's newest Toki Connect run for that game", () => {
    expect(state([])).toBe("todo");
    expect(state([job({ status: "working" })])).toBe("run");
    expect(state([job({ status: "question" })])).toBe("run");
    expect(state([job({ pr_url: "https://github.com/dev/game/pull/3" })])).toBe("pr");
    expect(state([job({ source: "upload" })])).toBe("live");
    expect(state([job({})])).toBe("already"); // finished without a pull request: the game had it
    expect(state([job({ status: "failed" })])).toBe("failed");
    // Newest first: a run that worked after one that failed.
    expect(state([job({ pr_url: "https://github.com/dev/game/pull/4" }), job({ status: "failed" })])).toBe("pr");
  });

  it("knows when the pull request was merged or closed", () => {
    const pr = "https://github.com/dev/game/pull/3";
    expect(state([job({ pr_url: pr, pr_state: "open" })])).toBe("pr");
    expect(state([job({ pr_url: pr, pr_state: "merged" })])).toBe("merged");
    expect(state([job({ pr_url: pr, pr_state: "closed" })])).toBe("closed");
    const done = (jobs: ConnectJob[]) => isDone(updateState(host, { id: "g1" }, jobs));
    expect(done([job({ pr_url: pr, pr_state: "merged" })])).toBe(true);
    expect(done([job({ source: "upload" })])).toBe(true);
    expect(done([job({})])).toBe(true);
    expect(done([job({ pr_url: pr })])).toBe(false);
    expect(done([job({ pr_url: pr, pr_state: "closed" })])).toBe(false);
    expect(done([])).toBe(false);
  });

  it("doesn't count other games, other features, or runs from before the update", () => {
    expect(state([job({ game_id: "g2" })])).toBe("todo");
    expect(state([job({ game_id: null })])).toBe("todo");
    expect(state([job({ features: ["scores"] })])).toBe("todo");
    expect(state([job({ created_at: "2026-11-09T10:00:00Z", pr_url: "https://github.com/dev/game/pull/1" })])).toBe("todo");
    // The same day, but before the update went live (a pull request for friend invites, without onHost).
    expect(state([job({ created_at: "2026-11-10T21:03:20Z", pr_url: "https://github.com/dev/game/pull/2" })])).toBe("todo");
    expect(state([job({ created_at: "2026-11-10T22:08:32Z" })])).toBe("already");
  });
});

describe("a run started on the Connect page without choosing the game", () => {
  it("counts for the game whose repository it changed", () => {
    const loose = job({ game_id: null, repo: "Dev/Apex", status: "working" });
    expect(updateState(host, { id: "g1", repo: "dev/apex" }, [loose]).state).toBe("run");
    expect(updateState(host, { id: "g1", repo: "dev/other" }, [loose]).state).toBe("todo");
    expect(updateState(host, { id: "g1", repo: null }, [loose]).state).toBe("todo");
    // A run that names another game doesn't count, even on the same repository.
    expect(updateState(host, { id: "g1", repo: "dev/apex" }, [job({ game_id: "g2", repo: "dev/apex" })]).state).toBe("todo");
  });
});

describe("starting an update in one click", () => {
  it("uses the logged-in account's own GitHub connection to the game's repository", () => {
    const repos = [{ installation_id: 7, repo: "dev/other" }, { installation_id: 9, repo: "Dev/Apex" }];
    expect(ownConnection(repos, "dev/apex")).toBe(9);
    // Only another account can reach it (e.g. an older account of the same developer).
    expect(ownConnection(repos, "dev/gone")).toBeNull();
    expect(ownConnection(undefined, "dev/apex")).toBeNull();
  });

  it("falls back to the Connect page with the update and the game filled in", () => {
    expect(updateConnectPath(host, "g1")).toBe("/connect?update=host&game=g1");
  });
});

describe("a run on a game uploaded to Toki", () => {
  it("adds high scores, what multiplayer games tell Toki, or a copy of the save", () => {
    expect(uploadFeatures(["multiplayer"])).toEqual(["multiplayer"]);
    expect(uploadFeatures(["scores", "multiplayer", "scores"])).toEqual(["scores", "multiplayer"]);
    expect(uploadFeatures(["saves", "fix", 7])).toEqual(["saves"]);
    expect(uploadFeatures(["fix", 7])).toEqual(["scores"]);
    expect(uploadFeatures(undefined)).toEqual(["scores"]);
    expect(uploadFeatures("multiplayer")).toEqual(["scores"]);
    expect(uploadFeatures(["achievements", "badges"])).toEqual(["achievements"]);
  });
});

describe("the achievements update", () => {
  const ach = gameUpdate("achievements")!;
  it("is for every game, and the instructions explain toki.achievement", () => {
    expect(ach.feature).toBe("achievements");
    expect(ach.applies({ multiplayer: false })).toBe(true);
    const text = updateInstructions(ach, "/* script */");
    expect(text).toContain('window.toki?.achievement("id")');
    expect(text).toContain('"achievements": [');
    expect(ach.only).toContain("step 6");
  });
});
