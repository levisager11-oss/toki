import { describe, expect, it } from "vitest";
import { hostFromMessage, invitePath, joinPath, maxPlayers, partyId, playUrl, roomCode, roomFromMessage } from "../src/lib/invites";
import { readTokiJson } from "../src/lib/hostingRules";
import { integrationGuide } from "../src/lib/integration";
import { gameLine, task, type Job } from "../server/connect/agent";
import { basics, readScan, withToki } from "../server/assist/scan";

const game = { play_url: "https://apex.example/play/?lang=de#top", multiplayer: true, join_param: "room" };

describe("room codes", () => {
  it("are read from what a player typed or pasted", () => {
    expect(roomCode(" ABCD ")).toBe("ABCD");
    expect(roomCode("k7-x_2")).toBe("k7-x_2");
    expect(roomCode("https://gloomwit.example/?room=WXYZ")).toBe("WXYZ");
    expect(roomCode("https://debt.example/?join=QRST", "join")).toBe("QRST");
    expect(roomCode("https://debt.example/?join=QRST")).toBe("QRST"); // a common name, whatever the game's is
  });

  it("are refused when they could be anything else", () => {
    for (const bad of ["", "  ", null, undefined, "AB CD", "a&b=c", "<b>", "x".repeat(33), "https://x.example/", "https://x.example/?room=A%20B", "javascript:alert(1)"]) {
      expect(roomCode(bad)).toBeNull();
    }
  });
});

describe("what the game tells Toki about its room", () => {
  it("is the code while the player is in a room, and nothing once they left", () => {
    expect(roomFromMessage({ toki: 1, type: "room", data: "ABCD" })).toBe("ABCD");
    expect(roomFromMessage({ toki: 1, type: "room", data: null })).toBeNull();
    expect(roomFromMessage({ toki: 1, type: "room", data: "not a code" })).toBeNull();
    expect(roomFromMessage({ toki: 1, type: "room", data: 1234 })).toBeNull();
  });

  it("forgets the room when the game starts again, e.g. after reloading itself", () => {
    expect(roomFromMessage({ toki: 1, type: "hello" })).toBeNull();
  });

  it("leaves the room alone for every other message", () => {
    for (const other of [null, "room", 7, {}, { type: "room", data: "ABCD" }, { toki: 2, type: "room", data: "ABCD" }, { toki: 1, type: "score", data: 5 }, { toki: 1, type: "store", data: {} }]) {
      expect(roomFromMessage(other)).toBeUndefined();
    }
  });
});

describe("what the game tells Toki about opening rooms", () => {
  it("is whether it can open one by itself, until it starts again", () => {
    expect(hostFromMessage({ toki: 1, type: "host", data: true })).toBe(true);
    expect(hostFromMessage({ toki: 1, type: "host", data: false })).toBe(false);
    expect(hostFromMessage({ toki: 1, type: "host", data: "yes" })).toBe(false);
    expect(hostFromMessage({ toki: 1, type: "hello" })).toBe(false);
    for (const other of [null, "host", {}, { type: "host", data: true }, { toki: 1, type: "room", data: "ABCD" }]) {
      expect(hostFromMessage(other)).toBeUndefined();
    }
  });
});

describe("the game's address for a room", () => {
  it("adds the code under the game's own name for it, keeping the rest", () => {
    expect(playUrl(game, "ABCD")).toBe("https://apex.example/play/?lang=de&room=ABCD#top");
    expect(playUrl({ ...game, join_param: "join" }, "ABCD")).toBe("https://apex.example/play/?lang=de&join=ABCD#top");
    expect(playUrl({ ...game, play_url: "https://apex.example/?room=OLD" }, "NEW")).toBe("https://apex.example/?room=NEW");
  });

  it("stays the normal address without a code, with a bad one, or for a single-player game", () => {
    expect(playUrl(game, null)).toBe(game.play_url);
    expect(playUrl(game, "a b")).toBe(game.play_url);
    expect(playUrl({ ...game, multiplayer: false }, "ABCD")).toBe(game.play_url);
    expect(playUrl({ ...game, play_url: "not a link" }, "ABCD")).toBe("not a link");
  });

  it("leads to the game's page on Toki", () => {
    expect(joinPath("apex", "ABCD")).toBe("/game/apex?room=ABCD");
    // With the party of whoever invited, when there is one.
    const party = "22222222-2222-4222-8222-222222222222";
    expect(joinPath("apex", "ABCD", party)).toBe(`/game/apex?room=ABCD&party=${party}`);
    expect(joinPath("apex", "ABCD", "x&y=z")).toBe("/game/apex?room=ABCD");
    expect(joinPath("apex", "ABCD", null)).toBe("/game/apex?room=ABCD");
    expect(partyId(party)).toBe(party);
    expect(partyId("nope")).toBeNull();
    expect(invitePath("apex", "11111111-1111-4111-8111-111111111111")).toBe("/game/apex?invite=11111111-1111-4111-8111-111111111111");
    expect(maxPlayers({ max_players: 4 })).toBe(4);
    expect(maxPlayers({ max_players: null })).toBeNull();
  });
});

describe("what a game says about its multiplayer", () => {
  it("is read from toki.json, leaving out what's wrong", () => {
    expect(readTokiJson({ multiplayer: true, max_players: 4, join_param: "join" })).toEqual({ multiplayer: true, max_players: 4, join_param: "join" });
    expect(readTokiJson({ multiplayer: "yes", max_players: 1, join_param: "a b" })).toEqual({});
    expect(readTokiJson({ max_players: 2.5, join_param: "Room" })).toEqual({});
  });

  it("is proposed when adding a game: only on a sure sign, or when the AI or toki.json say so", () => {
    const plain = basics([{ path: "index.html", text: "<title>Moon Hop</title><script>let lobby, score</script>" }], "moon-hop");
    expect(plain.multiplayer).toBe(false);
    expect(basics([{ path: "index.html", text: "<script>window.toki?.room(code)</script>" }], "x").multiplayer).toBe(true);
    expect(readScan('{"multiplayer":true}', plain).multiplayer).toBe(true);
    expect(readScan('{"multiplayer":"true"}', plain).multiplayer).toBe(false);
    expect(withToki(plain, { multiplayer: true }).multiplayer).toBe(true);
  });
});

describe("Toki Connect", () => {
  const job: Job = {
    id: "j", repo: "dev/game", features: ["multiplayer"], notes: "", status: "working", messages: [], state: {},
    game: { title: "Debtdrifter", score_order: "high", score_format: "points", join_param: "join" },
  };

  it("explains friend invites in the guide and asks only for them", () => {
    const guide = integrationGuide("/* script */");
    expect(guide).toContain("window.toki?.room(code)");
    expect(guide).toContain("window.toki?.room(null)");
    expect(guide).toContain("?room=CODE");
    expect(guide).toContain("window.toki?.onHost(fn)");
    const text = task(job, "/* script */");
    expect(text).toContain("add only: friend invites");
    expect(text).not.toContain("high scores (step 4");
  });

  it("tells the AI how Toki opens this game for an invited friend", () => {
    expect(gameLine(job)).toContain("?join=CODE");
    expect(gameLine({ ...job, features: ["scores"] })).not.toContain("CODE");
  });
});

describe("the game script", () => {
  /** Runs public/toki-save.js in a page that is (or isn't) shown inside Toki. */
  async function load(inToki: boolean) {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../public/toki-save.js", import.meta.url), "utf8");
    const sent: unknown[] = [];
    const top = { postMessage: (m: unknown, origin: string) => sent.push([m, origin]) };
    const store = { length: 0, getItem: () => null, key: () => null };
    const listeners: ((e: unknown) => void)[] = [];
    const win: Record<string, unknown> = { localStorage: store, addEventListener: (type: string, fn: (e: unknown) => void) => type === "message" && listeners.push(fn) };
    win.parent = inToki ? top : win;
    const doc = { referrer: "https://www.playtoki.app/game/apex", hidden: false, addEventListener() {} };
    const Storage = { prototype: { setItem() {}, removeItem() {}, clear() {} } };
    new Function("window", "location", "document", "Storage", "setTimeout", src)(win, { ancestorOrigins: [] }, doc, Storage, () => 0);
    /** A message to the game's page: from Toki, or from anyone else. */
    const tell = (data: unknown, fromToki = true) => listeners.forEach((fn) => fn({ data, source: fromToki ? top : {} }));
    return { toki: win.toki as { room(code: unknown): void; onHost(fn: unknown): void }, sent, tell };
  }

  it("tells Toki the room, and that it closed", async () => {
    const { toki, sent } = await load(true);
    sent.length = 0; // the "hello"
    toki.room("ABCD");
    toki.room(1234);
    toki.room(null);
    toki.room("");
    expect(sent).toEqual([
      [{ toki: 1, type: "room", data: "ABCD" }, "https://www.playtoki.app"],
      [{ toki: 1, type: "room", data: "1234" }, "https://www.playtoki.app"],
      [{ toki: 1, type: "room", data: null }, "https://www.playtoki.app"],
      [{ toki: 1, type: "room", data: null }, "https://www.playtoki.app"],
    ]);
  });

  it("opens a room when Toki asks, if the game said it can", async () => {
    const { toki, sent, tell } = await load(true);
    sent.length = 0;
    tell({ toki: 1, type: "host" }); // the game didn't say it can: nothing happens
    let opened = 0;
    toki.onHost(() => opened++);
    expect(sent).toEqual([[{ toki: 1, type: "host", data: true }, "https://www.playtoki.app"]]);
    tell({ toki: 1, type: "host" });
    expect(opened).toBe(1);
    // Only Toki may ask, and only with that message.
    tell({ toki: 1, type: "host" }, false);
    tell({ toki: 1, type: "save", data: null });
    tell({ type: "host" });
    expect(opened).toBe(1);
    // A game's own error doesn't reach the page around it.
    toki.onHost(() => { throw new Error("no server"); });
    expect(() => tell({ toki: 1, type: "host" })).not.toThrow();
    // The game takes it back.
    toki.onHost(null);
    expect(sent.at(-1)).toEqual([{ toki: 1, type: "host", data: false }, "https://www.playtoki.app"]);
    tell({ toki: 1, type: "host" });
    expect(opened).toBe(1);
  });

  it("does nothing outside Toki", async () => {
    const { toki, sent } = await load(false);
    toki.room("ABCD");
    toki.onHost(() => {});
    expect(sent).toEqual([]);
  });
});
