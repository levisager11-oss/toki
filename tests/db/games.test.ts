import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./harness";

let t: TestDb;
beforeAll(async () => {
  t = await testDb();
}, 60_000);

describe("banner picture", () => {
  it("lets the game's maker set a banner, but not other creators", async () => {
    const dev = await t.user("creator");
    const other = await t.user("creator");
    const g = await t.game(dev);
    const url = "https://example.com/banner.png";
    expect(await t.as(other, "update games set banner_url = $2 where id = $1 returning id", [g.id, url])).toHaveLength(0);
    const [row] = await t.as<{ banner_url: string }>(dev, "update games set banner_url = $2 where id = $1 returning banner_url", [g.id, url]);
    expect(row.banner_url).toBe(url);
    expect(await t.as(null, "select banner_url from games where id = $1", [g.id])).toEqual([{ banner_url: url }]);
  });

  it("only takes https links", async () => {
    const dev = await t.user("creator");
    const g = await t.game(dev);
    await expect(t.as(dev, "update games set banner_url = 'http://example.com/b.png' where id = $1", [g.id])).rejects.toThrow(/check/);
    await expect(t.as(dev, "update games set banner_url = $2 where id = $1", [g.id, `https://x.dev/${"a".repeat(500)}`])).rejects.toThrow(/check/);
  });
});
