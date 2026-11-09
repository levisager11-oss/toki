import { beforeAll, describe, expect, it } from "vitest";
import { testDb, type TestDb } from "./harness";

let t: TestDb;
let dev: { id: string };

beforeAll(async () => {
  t = await testDb();
  dev = await t.user("creator");
}, 60_000);

const oldSlugs = async (id: string) =>
  (await t.admin<{ old_slugs: string[] }>("select old_slugs from games where id = $1", [id]))[0].old_slugs;

describe("renamed games", () => {
  it("remember their old addresses, newest first, without the current one", async () => {
    const g = await t.game(dev);
    await t.as(dev, "update games set slug = 'first-name' where id = $1", [g.id]);
    await t.as(dev, "update games set slug = 'second-name' where id = $1", [g.id]);
    expect(await oldSlugs(g.id)).toEqual(["first-name", g.slug]);
    await t.as(dev, "update games set slug = 'first-name' where id = $1", [g.id]);
    expect(await oldSlugs(g.id)).toEqual(["second-name", g.slug]);
  });

  it("can't have their list changed by developers", async () => {
    const g = await t.game(dev);
    await expect(t.as(dev, "update games set old_slugs = '{fake}' where id = $1", [g.id])).resolves.toBeDefined();
    expect(await oldSlugs(g.id)).toEqual([]);
    await t.as(dev, "insert into games (slug, title, category, play_url, old_slugs) values ('fresh-one', 'x', 'arcade', 'https://e.com', '{taken}')");
    expect((await t.admin<{ old_slugs: string[] }>("select old_slugs from games where slug = 'fresh-one'"))[0].old_slugs).toEqual([]);
  });
});
