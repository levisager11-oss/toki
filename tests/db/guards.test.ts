import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let game: { id: string };
let a: { id: string };
let b: { id: string };

beforeAll(async () => {
  t = await testDb();
  game = await t.game(await t.user("creator"));
}, 60_000);

beforeEach(async () => {
  a = await t.user();
  b = await t.user();
});

const rpc = async <T = unknown>(who: Who, fn: string, args: unknown[] = [], types: string[] = []) => {
  const params = args.map((_, i) => `$${i + 1}${types[i] ? `::${types[i]}` : ""}`).join(", ");
  const rows = await t.as<Record<string, T>>(who, `select ${fn}(${params}) as r`, args);
  return rows[0]?.r as T;
};
const like = (who: Who, visitor: string, on: boolean) => rpc<number>(who, "set_like", [game.id, visitor, on], ["uuid", "uuid", "boolean"]);
const myLikes = async (who: Who) => (await t.as(who, "select * from my_likes()")).length;

describe("likes", () => {
  it("can't be removed by a visitor who uses an account's id", async () => {
    await like(a, crypto.randomUUID(), true);
    expect(await myLikes(a)).toBe(1);
    expect(await like(null, a.id, false)).toBe(1);
    expect(await myLikes(a)).toBe(1);
  });

  it("can't be added under an account's id by a visitor", async () => {
    await like(null, b.id, true);
    expect(await myLikes(b)).toBe(0);
  });

  it("can't be taken from another account", async () => {
    await like(a, crypto.randomUUID(), true);
    expect(await rpc(b, "claim_likes", [a.id], ["uuid"])).toBe(0);
    expect(await myLikes(a)).toBe(1);
    expect(await myLikes(b)).toBe(0);
    await like(a, crypto.randomUUID(), false);
  });

  it("still move from this browser to the account on login", async () => {
    const visitor = crypto.randomUUID();
    await like(null, visitor, true);
    expect(await rpc(b, "claim_likes", [visitor], ["uuid"])).toBe(1);
    expect(await myLikes(b)).toBe(1);
    await like(b, crypto.randomUUID(), false);
  });
});

describe("friend requests", () => {
  const requests = async (to: { id: string }) =>
    Number((await t.admin<{ n: string }>("select count(*) n from notifications where user_id = $1 and kind = 'friend_request'", [to.id]))[0].n);

  it("notify the same player only once a day, even when taken back and sent again", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await rpc(a, "send_friend_request", [b.id], ["uuid"])).toBe("sent");
      await rpc(a, "remove_friend", [b.id], ["uuid"]);
    }
    expect(await requests(b)).toBe(1);
  });

  it("stop at 30 a day, even when taken back", async () => {
    const others = [];
    for (let i = 0; i < 31; i++) others.push(await t.user());
    for (const o of others.slice(0, 30)) {
      await rpc(a, "send_friend_request", [o.id], ["uuid"]);
      await rpc(a, "remove_friend", [o.id], ["uuid"]);
    }
    await expect(rpc(a, "send_friend_request", [others[30].id], ["uuid"])).rejects.toThrow(/rate_limited/);
  });

  it("still work normally", async () => {
    expect(await rpc(a, "send_friend_request", [b.id], ["uuid"])).toBe("sent");
    expect(await rpc(a, "send_friend_request", [b.id], ["uuid"])).toBe("sent");
    expect(await requests(b)).toBe(1);
    expect(await rpc(b, "send_friend_request", [a.id], ["uuid"])).toBe("friends");
  });
});
