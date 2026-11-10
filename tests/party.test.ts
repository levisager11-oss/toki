import { describe, expect, it } from "vitest";
import { followTarget, isParty, readParty, type Party } from "../src/lib/party";

const games = [{ id: "g1", slug: "apex", title: "Apex" }, { id: "g2", slug: "deepsub", title: "Deepsub" }];
const mia = { id: "mia", username: "mia", avatar_url: null, avatar_seed: null, playing: "g1" };
const tom = { id: "tom", username: "tom", avatar_url: null, avatar_seed: null, playing: null };
const party: Party = { id: "p1", leader: "mia", game: "g1", code: "ABCD", seq: 3, chat: "c1", members: [mia, tom] };
const at = (pathname: string, search = "") => ({ pathname, search });

describe("a party as the server tells it", () => {
  it("is read carefully", () => {
    expect(readParty({ ...party, seq: "3", code: null, game: null, extra: 1 })).toEqual({ ...party, code: null, game: null });
    expect(readParty({ ...party, members: [mia, null, { id: 5 }] })?.members).toEqual([mia]);
    for (const bad of [null, undefined, "party", {}, { id: "p1" }, { id: "p1", leader: "mia" }]) expect(readParty(bad)).toBeNull();
  });

  it("only shows once a friend is in it", () => {
    expect(isParty(party)).toBe(true);
    expect(isParty({ ...party, members: [mia] })).toBe(false); // invited, and nobody came yet
    expect(isParty(null)).toBe(false);
  });
});

describe("following the party's leader", () => {
  it("leads a member to the leader's room, once per room", () => {
    const f = followTarget(party, "tom", games, at("/"))!;
    expect(f).toMatchObject({ key: "p1:3", to: "/game/apex?room=ABCD", there: false, game: games[0], leader: mia });
    // The next room is another one to follow.
    expect(followTarget({ ...party, code: "EFGH", seq: 4 }, "tom", games, at("/"))).toMatchObject({ key: "p1:4", to: "/game/apex?room=EFGH" });
    expect(followTarget({ ...party, game: "g2", code: "EFGH", seq: 5 }, "tom", games, at("/game/apex", "?room=ABCD"))).toMatchObject({ to: "/game/deepsub?room=EFGH", there: false });
  });

  it("knows when the member is there already", () => {
    expect(followTarget(party, "tom", games, at("/game/apex", "?room=ABCD"))?.there).toBe(true);
    expect(followTarget(party, "tom", games, at("/game/apex/", "?room=ABCD&party=p1"))?.there).toBe(true);
    expect(followTarget(party, "tom", games, at("/game/apex", "?room=OLD"))?.there).toBe(false);
    expect(followTarget(party, "tom", games, at("/game/apex"))?.there).toBe(false);
    expect(followTarget(party, "tom", games, at("/game/apex/feedback", "?room=ABCD"))?.there).toBe(false);
  });

  it("moves nobody without a room to go to", () => {
    expect(followTarget(party, "mia", games, at("/"))).toBeNull(); // the leader follows nobody
    expect(followTarget({ ...party, code: null }, "tom", games, at("/"))).toBeNull(); // the leader is in no room
    expect(followTarget({ ...party, members: [tom] }, "tom", games, at("/"))).toBeNull();
    expect(followTarget({ ...party, game: "gone" }, "tom", games, at("/"))).toBeNull();
    expect(followTarget(party, undefined, games, at("/"))).toBeNull();
    expect(followTarget(null, "tom", games, at("/"))).toBeNull();
    expect(followTarget(party, "tom", null, at("/"))).toBeNull();
  });
});
