import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let creator: { id: string }; // trusted
let player: { id: string }; // not trusted
let stranger: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  creator = await t.user("creator");
  stranger = await t.user();
}, 60_000);

// A new untrusted developer for each test, so the limit of 3 waiting games doesn't add up.
beforeEach(async () => {
  player = await t.user();
});

type GameRow = { id: string; slug: string; status: string; play_url: string; pending_play_url: string | null; review_note: string | null; featured: boolean; reviewed_by: string | null };
let n = 0;
async function submit(who: Who, extra: Record<string, unknown> = {}) {
  const slug = `review-${++n}`;
  const cols = ["slug", "title", "category", "play_url", "created_by", ...Object.keys(extra)];
  const vals = [slug, "My game", "arcade", "https://one.example", (who as { id: string }).id, ...Object.values(extra)];
  const [g] = await t.as<GameRow>(who, `insert into games (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, vals);
  return g;
}
const row = async (id: string) => (await t.admin<GameRow>("select * from games where id = $1", [id]))[0];
const seen = async (who: Who, id: string) => (await t.as<GameRow>(who, "select * from games where id = $1", [id]))[0];
const review = (who: Who, id: string, approve: boolean, note: string | null = null) =>
  t.as<{ review_game: string }>(who, "select review_game($1, $2, $3)", [id, approve, note]).then((r) => r[0].review_game);
const setUrl = (who: Who, id: string, url: string) => t.as<GameRow>(who, "update games set play_url = $2, title = 'Changed' where id = $1 returning *", [id, url]).then((r) => r[0]);

describe("submitting a game", () => {
  it("lets any account submit; it waits for review and only the developer and admins see it", async () => {
    const g = await submit(player);
    expect(g.status).toBe("pending");
    expect(await seen(player, g.id)).toBeDefined();
    expect(await seen(admin, g.id)).toBeDefined();
    expect(await seen(stranger, g.id)).toBeUndefined();
    expect(await seen(null, g.id)).toBeUndefined();
  });

  it("puts games of trusted creators and admins live right away", async () => {
    expect((await submit(creator)).status).toBe("approved");
    expect((await submit(admin)).status).toBe("approved");
  });

  it("doesn't let developers approve or feature their own game", async () => {
    const g = await submit(player, { status: "approved", featured: true, reviewed_by: player.id });
    expect(g).toMatchObject({ status: "pending", featured: false, reviewed_by: null });
    const [u] = await t.as<GameRow>(player, "update games set status = 'approved', review_note = 'ok' where id = $1 returning *", [g.id]);
    expect(u).toMatchObject({ status: "pending", review_note: null });
  });

  it("allows 3 games waiting at once per account", async () => {
    for (let i = 0; i < 3; i++) await submit(player);
    await expect(submit(player)).rejects.toThrow(/too_many_pending/);
  });

  it("doesn't let visitors submit", async () => {
    await expect(t.as(null, "insert into games (slug, title, category, play_url) values ('x-visitor', 'x', 'arcade', 'https://x.example')")).rejects.toThrow(/row-level security|permission denied/);
  });
});

describe("reviewing", () => {
  it("lets an admin approve a game, which then shows for everyone", async () => {
    const g = await submit(player);
    expect(await review(admin, g.id, true, "  Welcome!  ")).toBe("approved");
    expect(await row(g.id)).toMatchObject({ status: "approved", review_note: "Welcome!", reviewed_by: admin.id });
    expect(await seen(null, g.id)).toBeDefined();
  });

  it("lets an admin decline with a note; changing the game sends it in again", async () => {
    const g = await submit(player);
    expect(await review(admin, g.id, false, "The link doesn't load.")).toBe("rejected");
    expect(await seen(player, g.id)).toMatchObject({ status: "rejected", review_note: "The link doesn't load." });
    expect(await seen(stranger, g.id)).toBeUndefined();
    const u = await setUrl(player, g.id, "https://fixed.example");
    expect(u).toMatchObject({ status: "pending", play_url: "https://fixed.example", review_note: null });
  });

  it("only lets admins review", async () => {
    const g = await submit(player);
    await expect(review(creator, g.id, true)).rejects.toThrow(/not_allowed/);
    await expect(review(player, g.id, true)).rejects.toThrow(/not_allowed/);
    await expect(t.as(null, "select review_game($1, true, null)", [g.id])).rejects.toThrow(/permission denied/);
  });

  it("refuses to review what doesn't wait for review", async () => {
    const g = await submit(creator);
    await expect(review(admin, g.id, true)).rejects.toThrow(/nothing_to_review/);
    await expect(review(admin, crypto.randomUUID(), true)).rejects.toThrow(/not_found/);
  });
});

describe("changing the link of an approved game", () => {
  async function approved() {
    const g = await submit(player);
    await review(admin, g.id, true);
    return g;
  }

  it("keeps the approved link live until the new one is approved; other changes apply at once", async () => {
    const g = await approved();
    const u = await setUrl(player, g.id, "https://two.example");
    expect(u).toMatchObject({ status: "approved", play_url: "https://one.example", pending_play_url: "https://two.example" });
    expect(await seen(null, g.id)).toMatchObject({ play_url: "https://one.example", title: "Changed" });
    await review(admin, g.id, true);
    expect(await row(g.id)).toMatchObject({ play_url: "https://two.example", pending_play_url: null });
  });

  it("keeps the approved link when the new one is declined", async () => {
    const g = await approved();
    await setUrl(player, g.id, "https://bad.example");
    expect(await review(admin, g.id, false, "Doesn't load")).toBe("approved");
    expect(await row(g.id)).toMatchObject({ status: "approved", play_url: "https://one.example", pending_play_url: null, review_note: "Doesn't load" });
  });

  it("withdraws the new link when the developer goes back to the live one", async () => {
    const g = await approved();
    await setUrl(player, g.id, "https://two.example");
    const u = await setUrl(player, g.id, "https://one.example");
    expect(u.pending_play_url).toBeNull();
  });

  it("lets trusted creators change their link right away", async () => {
    const g = await submit(creator);
    const u = await setUrl(creator, g.id, "https://new.example");
    expect(u).toMatchObject({ play_url: "https://new.example", pending_play_url: null });
  });

  it("lets admins change any link right away", async () => {
    const g = await approved();
    const [u] = await t.as<GameRow>(admin, "update games set play_url = 'https://admin.example' where id = $1 returning *", [g.id]);
    expect(u).toMatchObject({ play_url: "https://admin.example", pending_play_url: null });
  });

  it("doesn't let developers set the waiting link of someone else's game", async () => {
    const g = await approved();
    expect(await t.as(stranger, "update games set play_url = 'https://evil.example' where id = $1 returning id", [g.id])).toHaveLength(0);
  });
});

describe("trusted creators", () => {
  it("lets admins trust an account, so its games skip review, and take it back", async () => {
    expect(await t.as<{ set_trusted: string }>(admin, "select set_trusted($1, true)", [player.id])).toEqual([{ set_trusted: "creator" }]);
    expect((await submit(player)).status).toBe("approved");
    await t.as(admin, "select set_trusted($1, false)", [player.id]);
    expect((await submit(player)).status).toBe("pending");
  });

  it("only lets admins do it, and keeps admins admins", async () => {
    await expect(t.as(creator, "select set_trusted($1, true)", [player.id])).rejects.toThrow(/not_allowed/);
    await expect(t.as(player, "select set_trusted($1, true)", [player.id])).rejects.toThrow(/not_allowed/);
    expect(await t.as<{ set_trusted: string }>(admin, "select set_trusted($1, false)", [admin.id])).toEqual([{ set_trusted: "admin" }]);
  });
});

describe("around review", () => {
  it("keeps games from before as approved", async () => {
    const g = await t.game(creator); // added without a user, like the games already on Toki
    expect((await row(g.id)).status).toBe("approved");
  });

  it("doesn't take feedback on someone else's game under review", async () => {
    const g = await submit(player);
    await expect(t.as(stranger, "insert into feedback_posts (game_id, kind, title) values ($1, 'bug', 'Sneaky')", [g.id])).rejects.toThrow(/row-level security/);
    expect(await t.as(player, "insert into feedback_posts (game_id, kind, title) values ($1, 'bug', 'My own note') returning id", [g.id])).toHaveLength(1);
  });

  it("tells the server about isolation for games under review too", async () => {
    const g = await submit(player, { needs_isolation: true });
    expect(await t.as(null, "select game_needs_isolation($1) as on", [g.slug])).toEqual([{ on: true }]);
    expect(await t.as(null, "select game_needs_isolation('no-such-game') as on")).toEqual([{ on: false }]);
  });
});
