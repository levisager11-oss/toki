import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let dev: { id: string };
let otherDev: { id: string };
let player: { id: string };
let stranger: { id: string };
let devGame: { id: string };
let otherGame: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  dev = await t.user("creator");
  otherDev = await t.user("creator");
  stranger = await t.user();
  devGame = await t.game(dev);
  otherGame = await t.game(otherDev);
}, 60_000);

// A new player for each test, so the daily limit doesn't add up across tests.
beforeEach(async () => {
  player = await t.user();
});

type Idea = { id: string; author_id: string; title: string; body: string; status: string; claimed_by: string | null; game_id: string | null; reply_count: number };

async function propose(who: Who, title = "A game about penguins", body = "Sliding on ice, collecting fish.") {
  const [i] = await t.as<Idea>(who, "insert into game_ideas (title, body) values ($1, $2) returning *", [title, body]);
  return i;
}
const read = async (who: Who, id: string) => (await t.as<Idea>(who, "select * from game_ideas where id = $1", [id]))[0];
const stored = async (id: string) => (await t.admin<Idea>("select * from game_ideas where id = $1", [id]))[0];
const claim = (who: Who, id: string) => t.as(who, "select claim_game_idea($1)", [id]);
const release = (who: Who, id: string) => t.as(who, "select release_game_idea($1)", [id]);
const finish = (who: Who, id: string, game: string) => t.as(who, "select finish_game_idea($1, $2)", [id, game]);
const reply = (who: Who, id: string, body = "Sounds fun!") =>
  t.as<{ id: string }>(who, "insert into game_idea_replies (idea_id, body) values ($1, $2) returning id", [id, body]);
const notes = (user: { id: string }, idea: string) =>
  t.admin<{ event: string; actor_id: string | null }>(
    "select data->>'event' as event, actor_id from notifications where user_id = $1 and kind = 'game_idea' and data->>'idea' = $2 order by id",
    [user.id, idea],
  );

describe("proposing", () => {
  it("lets players and developers propose, but not visitors", async () => {
    expect(await propose(player)).toMatchObject({ author_id: player.id, status: "open", claimed_by: null, reply_count: 0 });
    expect(await propose(dev, "A game from a developer")).toMatchObject({ author_id: dev.id, status: "open" });
    await expect(propose(null)).rejects.toThrow(/permission denied/);
  });

  it("trims the words and checks their length", async () => {
    expect(await propose(player, "  Space farm  ", "  Grow plants.  ")).toMatchObject({ title: "Space farm", body: "Grow plants." });
    await expect(propose(player, "ab")).rejects.toThrow(/check/);
    await expect(propose(player, "x".repeat(101))).rejects.toThrow(/check/);
    await expect(propose(player, "Long text", "x".repeat(2001))).rejects.toThrow(/check/);
  });

  it("doesn't let anyone set what only the server sets", async () => {
    await expect(t.as(player, "insert into game_ideas (title, author_id) values ('abc', $1)", [stranger.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "insert into game_ideas (title, claimed_by) values ('abc', $1)", [dev.id])).rejects.toThrow(/permission denied/);
    const i = await propose(player);
    await expect(t.as(player, "update game_ideas set title = 'Other' where id = $1", [i.id])).rejects.toThrow(/permission denied/);
    await expect(t.as(dev, "update game_ideas set claimed_by = $2 where id = $1", [i.id, dev.id])).rejects.toThrow(/permission denied/);
  });

  it("limits how many ideas an account proposes in a day", async () => {
    for (let n = 0; n < 3; n++) await propose(player, `Idea number ${n}`);
    await expect(propose(player, "One too many")).rejects.toThrow(/rate_limited/);
  });

  it("doesn't take ideas from banned accounts", async () => {
    await t.admin("update profiles set banned_until = now() + interval '1 day' where id = $1", [player.id]);
    await expect(propose(player)).rejects.toThrow(/banned/);
  });
});

describe("who sees ideas", () => {
  it("shows an idea to whoever proposed it, developers and admins only", async () => {
    const i = await propose(player);
    expect(await read(player, i.id)).toMatchObject({ id: i.id });
    expect(await read(dev, i.id)).toMatchObject({ id: i.id });
    expect(await read(otherDev, i.id)).toMatchObject({ id: i.id });
    expect(await read(admin, i.id)).toMatchObject({ id: i.id });
    expect(await read(stranger, i.id)).toBeUndefined();
    await expect(read(null, i.id)).rejects.toThrow(/permission denied/);
  });

  it("tells every developer about a new idea, but not players or whoever proposed it", async () => {
    const i = await propose(dev, "A developer's own idea");
    expect(await notes(otherDev, i.id)).toEqual([{ event: "new", actor_id: dev.id }]);
    expect(await notes(admin, i.id)).toEqual([{ event: "new", actor_id: dev.id }]);
    expect(await notes(dev, i.id)).toEqual([]);
    expect(await notes(stranger, i.id)).toEqual([]);
  });
});

describe("discussion", () => {
  it("is for developers and whoever proposed the idea", async () => {
    const i = await propose(player);
    await reply(dev, i.id, "  How many players?  ");
    await reply(player, i.id, "Two!");
    await expect(reply(stranger, i.id)).rejects.toThrow(/row-level security/);
    await expect(reply(null, i.id)).rejects.toThrow(/permission denied/);

    expect((await stored(i.id)).reply_count).toBe(2);
    expect(await t.as(player, "select body from game_idea_replies where idea_id = $1 order by created_at", [i.id])).toEqual([{ body: "How many players?" }, { body: "Two!" }]);
    expect(await t.as(stranger, "select body from game_idea_replies where idea_id = $1", [i.id])).toEqual([]);
  });

  it("tells whoever proposed the idea, and the developer building it", async () => {
    const i = await propose(player);
    await claim(dev, i.id);
    await reply(otherDev, i.id);
    expect((await notes(player, i.id)).map((n) => n.event)).toEqual(["claimed", "reply"]);
    expect((await notes(dev, i.id)).map((n) => n.event)).toEqual(["new", "reply"]);
    // Not for your own reply.
    expect((await notes(otherDev, i.id)).map((n) => n.event)).toEqual(["new"]);
  });

  it("lets people delete their own replies, and admins any", async () => {
    const i = await propose(player);
    const [mine] = await reply(player, i.id);
    const [devs] = await reply(dev, i.id);
    await t.as(otherDev, "delete from game_idea_replies where id = $1", [mine.id]);
    expect((await stored(i.id)).reply_count).toBe(2);
    await t.as(player, "delete from game_idea_replies where id = $1", [mine.id]);
    await t.as(admin, "delete from game_idea_replies where id = $1", [devs.id]);
    expect((await stored(i.id)).reply_count).toBe(0);
  });
});

describe("claiming", () => {
  it("lets one developer claim an idea", async () => {
    const i = await propose(player);
    await claim(dev, i.id);
    expect(await stored(i.id)).toMatchObject({ status: "claimed", claimed_by: dev.id });
    await expect(claim(otherDev, i.id)).rejects.toThrow(/taken/);
    expect((await notes(player, i.id)).at(-1)).toEqual({ event: "claimed", actor_id: dev.id });
  });

  it("is only for developers", async () => {
    const i = await propose(player);
    await expect(claim(player, i.id)).rejects.toThrow(/not_developer/);
    await expect(claim(null, i.id)).rejects.toThrow(/permission denied/);
    await expect(claim(dev, crypto.randomUUID())).rejects.toThrow(/not_found/);
  });

  it("lets the developer give it back, and admins take it away", async () => {
    const i = await propose(player);
    await claim(dev, i.id);
    await expect(release(otherDev, i.id)).rejects.toThrow(/not_yours/);
    await expect(release(player, i.id)).rejects.toThrow(/not_yours/);
    await release(dev, i.id);
    expect(await stored(i.id)).toMatchObject({ status: "open", claimed_by: null });
    expect((await notes(player, i.id)).at(-1)).toEqual({ event: "released", actor_id: dev.id });

    await claim(otherDev, i.id);
    await release(admin, i.id);
    expect(await stored(i.id)).toMatchObject({ status: "open", claimed_by: null });
    expect((await notes(otherDev, i.id)).at(-1)).toEqual({ event: "released", actor_id: admin.id });
  });

  it("is open again when the developer's account is deleted", async () => {
    const gone = await t.user("creator");
    const i = await propose(player);
    await claim(gone, i.id);
    await t.admin("delete from profiles where id = $1", [gone.id]);
    expect(await stored(i.id)).toMatchObject({ status: "open", claimed_by: null });
  });

  it("is done once the developer links their game", async () => {
    const i = await propose(player);
    await expect(finish(dev, i.id, devGame.id)).rejects.toThrow(/not_yours/);
    await claim(dev, i.id);
    await expect(finish(otherDev, i.id, otherGame.id)).rejects.toThrow(/not_yours/);
    await expect(finish(dev, i.id, otherGame.id)).rejects.toThrow(/bad_game/);
    await finish(dev, i.id, devGame.id);
    expect(await stored(i.id)).toMatchObject({ status: "done", claimed_by: dev.id, game_id: devGame.id });
    expect((await notes(player, i.id)).at(-1)).toEqual({ event: "done", actor_id: dev.id });
    // Done stays done.
    await expect(release(dev, i.id)).rejects.toThrow(/not_yours/);
    await expect(claim(otherDev, i.id)).rejects.toThrow(/taken/);
  });
});

describe("deleting", () => {
  it("lets whoever proposed an idea delete it until a developer picks it", async () => {
    const i = await propose(player);
    await t.as(dev, "delete from game_ideas where id = $1", [i.id]);
    expect(await stored(i.id)).toBeDefined();
    await claim(dev, i.id);
    await t.as(player, "delete from game_ideas where id = $1", [i.id]);
    expect(await stored(i.id)).toBeDefined();
    await release(dev, i.id);
    await t.as(player, "delete from game_ideas where id = $1", [i.id]);
    expect(await stored(i.id)).toBeUndefined();
  });

  it("lets admins delete any idea, with its discussion", async () => {
    const i = await propose(player);
    await claim(dev, i.id);
    await reply(dev, i.id);
    await t.as(admin, "delete from game_ideas where id = $1", [i.id]);
    expect(await stored(i.id)).toBeUndefined();
    expect(await t.admin("select 1 from game_idea_replies where idea_id = $1", [i.id])).toEqual([]);
  });
});

describe("the box on the home page", () => {
  const banner = async (who: Who) => (await t.as<{ idea_banner: boolean }>(who, "select idea_banner from site_settings"))[0].idea_banner;

  it("is shown unless an admin hides it", async () => {
    expect(await banner(null)).toBe(true);
    await t.as(dev, "update site_settings set idea_banner = false");
    await t.as(player, "update site_settings set idea_banner = false");
    expect(await banner(null)).toBe(true);
    await t.as(admin, "update site_settings set idea_banner = false");
    expect(await banner(null)).toBe(false);
    expect(await banner(player)).toBe(false);
    await t.as(admin, "update site_settings set idea_banner = true");
    expect(await banner(null)).toBe(true);
  });

  it("can't be changed by visitors, and has only the one row", async () => {
    await expect(t.as(null, "update site_settings set idea_banner = false")).rejects.toThrow(/permission denied/);
    await expect(t.as(admin, "insert into site_settings (id) values (2)")).rejects.toThrow(/permission denied/);
  });
});
