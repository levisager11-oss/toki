import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, type TestDb, type Who } from "./harness";

let t: TestDb;
let admin: { id: string };
let creator: { id: string };
let player: { id: string };
let stranger: { id: string };

beforeAll(async () => {
  t = await testDb();
  admin = await t.user("admin");
  creator = await t.user("creator");
  stranger = await t.user();
}, 60_000);

// A new player for each test, so the limits don't add up across tests.
beforeEach(async () => {
  player = await t.user();
});

type App = { id: string; user_id: string; status: string; review_note: string | null; about: string };
const ABOUT = "I make small pixel platformers with Godot.";
async function apply(who: Who, about = ABOUT, links = "https://me.itch.io") {
  const [a] = await t.as<App>(who, "insert into developer_applications (about, links) values ($1, $2) returning *", [about, links]);
  return a;
}
const review = (who: Who, id: string, approve: boolean, note: string | null = null) =>
  t.as<{ review_application: string }>(who, "select review_application($1, $2, $3)", [id, approve, note]).then((r) => r[0].review_application);
const role = async (id: string) => (await t.admin<{ role: string }>("select role from profiles where id = $1", [id]))[0].role;

describe("applying for a developer account", () => {
  it("lets a player apply; the server sets who and the status", async () => {
    const a = await apply(player, `  ${ABOUT}  `);
    expect(a).toMatchObject({ user_id: player.id, status: "pending", about: ABOUT });
  });

  it("doesn't let players set fields only the server or admins set", async () => {
    await expect(t.as(player, "insert into developer_applications (about, status) values ($1, 'approved')", [ABOUT])).rejects.toThrow(/permission denied/);
    await expect(t.as(player, "insert into developer_applications (about, user_id) values ($1, $2)", [ABOUT, stranger.id])).rejects.toThrow(/permission denied/);
  });

  it("allows one open application at a time, and 3 in 30 days", async () => {
    const a = await apply(player);
    await expect(apply(player)).rejects.toThrow(/duplicate key/);
    await review(admin, a.id, false);
    const b = await apply(player);
    await review(admin, b.id, false);
    await apply(player);
    await t.admin("update developer_applications set status = 'rejected' where user_id = $1", [player.id]);
    await expect(apply(player)).rejects.toThrow(/rate_limited/);
  });

  it("only takes applications from players", async () => {
    await expect(apply(creator)).rejects.toThrow(/already_developer/);
    await expect(apply(admin)).rejects.toThrow(/already_developer/);
    await expect(apply(null)).rejects.toThrow(/permission denied/);
  });

  it("needs a few words about what they make", async () => {
    await expect(apply(player, "games")).rejects.toThrow(/check/);
  });

  it("shows an application only to its author and admins", async () => {
    const a = await apply(player);
    expect(await t.as(player, "select id from developer_applications where id = $1", [a.id])).toHaveLength(1);
    expect(await t.as(admin, "select id from developer_applications where id = $1", [a.id])).toHaveLength(1);
    expect(await t.as(stranger, "select id from developer_applications where id = $1", [a.id])).toHaveLength(0);
    expect(await t.as(creator, "select id from developer_applications where id = $1", [a.id])).toHaveLength(0);
    await expect(t.as(null, "select id from developer_applications")).rejects.toThrow(/permission denied/);
  });

  it("lets the author withdraw an open application, but not change it", async () => {
    const a = await apply(player);
    await expect(t.as(player, "update developer_applications set status = 'approved' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
    expect(await t.as(stranger, "delete from developer_applications where id = $1 returning id", [a.id])).toHaveLength(0);
    await t.as(player, "delete from developer_applications where id = $1", [a.id]);
    const [row] = await t.as<App>(player, "select * from developer_applications where id = $1", [a.id]);
    expect(row.status).toBe("withdrawn");
    // ...so a new application is possible
    expect((await apply(player)).status).toBe("pending");
  });

  it("counts withdrawn applications towards the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await apply(player);
      await t.as(player, "delete from developer_applications where id = $1", [a.id]);
    }
    await expect(apply(player)).rejects.toThrow(/rate_limited/);
  });

  it("still deletes applications with the account", async () => {
    await apply(player);
    await t.admin("delete from auth.users where id = $1", [player.id]);
    expect(await t.admin("select id from developer_applications where user_id = $1", [player.id])).toHaveLength(0);
  });
});

describe("invites", () => {
  it("can't be used again after the account that used it is deleted", async () => {
    await t.admin("insert into invites (code, role) values ('TOKI-AAAAAA-BBBBBB', 'creator')");
    const u = await t.user();
    expect((await t.as<{ redeem_invite: string }>(u, "select redeem_invite('TOKI-AAAAAA-BBBBBB')"))[0].redeem_invite).toBe("creator");
    await t.admin("delete from auth.users where id = $1", [u.id]);
    expect((await t.as<{ check_invite: boolean }>(null, "select check_invite('TOKI-AAAAAA-BBBBBB')"))[0].check_invite).toBe(false);
    await expect(t.as(player, "select redeem_invite('TOKI-AAAAAA-BBBBBB')")).rejects.toThrow(/invalid_invite/);
  });
});

describe("reviewing applications", () => {
  it("makes the account a developer when an admin approves", async () => {
    const a = await apply(player);
    expect(await review(admin, a.id, true, " Welcome! ")).toBe("approved");
    expect(await role(player.id)).toBe("creator");
    const [row] = await t.as<App>(player, "select * from developer_applications where id = $1", [a.id]);
    expect(row).toMatchObject({ status: "approved", review_note: "Welcome!" });
    // ...and now they can add games, which go live right away.
    const [g] = await t.as<{ id: string }>(player, "insert into games (slug, title, category, play_url, created_by) values ('app-game-1', 'Mine', 'arcade', 'https://x.example', $1) returning id", [player.id]);
    expect(await t.as(null, "select id from games where id = $1", [g.id])).toHaveLength(1);
  });

  it("keeps the account a player when an admin declines; the note is visible to them", async () => {
    const a = await apply(player);
    expect(await review(admin, a.id, false, "Please add a link to a game you made.")).toBe("rejected");
    expect(await role(player.id)).toBe("player");
    expect(await t.as(player, "select review_note from developer_applications where id = $1", [a.id])).toEqual([{ review_note: "Please add a link to a game you made." }]);
  });

  it("only lets admins review, and only once", async () => {
    const a = await apply(player);
    await expect(review(creator, a.id, true)).rejects.toThrow(/not_allowed/);
    await expect(review(player, a.id, true)).rejects.toThrow(/not_allowed/);
    await review(admin, a.id, false);
    await expect(review(admin, a.id, true)).rejects.toThrow(/already_reviewed/);
    await expect(review(admin, crypto.randomUUID(), true)).rejects.toThrow(/not_found/);
  });

  it("lets admins give and take developer rights, but keeps admins admins", async () => {
    expect(await t.as(admin, "select set_developer($1, true) as r", [player.id])).toEqual([{ r: "creator" }]);
    expect(await t.as(admin, "select set_developer($1, false) as r", [player.id])).toEqual([{ r: "player" }]);
    expect(await t.as(admin, "select set_developer($1, false) as r", [admin.id])).toEqual([{ r: "admin" }]);
    await expect(t.as(creator, "select set_developer($1, true)", [player.id])).rejects.toThrow(/not_allowed/);
  });
});

describe("questions on an application", () => {
  const note = (who: Who, id: string, text: string) =>
    t.as<{ n: { by: string; text: string }[] }>(who, "select application_note($1, $2) as n", [id, text]).then((r) => r[0].n);
  const notifs = (who: { id: string }) =>
    t.admin<{ data: { event: string; application: string } }>("select data from notifications where user_id = $1 and kind = 'application' order by id", [who.id]);

  it("lets an admin ask and the applicant answer, each telling the other", async () => {
    const a = await apply(player);
    expect(await note(admin, a.id, "Which of these games did you make?")).toEqual([expect.objectContaining({ by: "admin", text: "Which of these games did you make?" })]);
    expect((await notifs(player)).map((n) => n.data)).toEqual([{ event: "question", application: a.id }]);
    const after = await note(player, a.id, "  All three.  ");
    expect(after.map((n) => [n.by, n.text])).toEqual([["admin", "Which of these games did you make?"], ["applicant", "All three."]]);
    expect((await notifs(admin)).at(-1)?.data).toEqual({ event: "answer", application: a.id });
    expect(await t.as(player, "select jsonb_array_length(notes) as n from developer_applications where id = $1", [a.id])).toEqual([{ n: 2 }]);
  });

  it("is only for the applicant and admins, and only while the application is open", async () => {
    const a = await apply(player);
    await expect(note(stranger, a.id, "hi")).rejects.toThrow(/not_allowed/);
    await expect(note(creator, a.id, "hi")).rejects.toThrow(/not_allowed/);
    await expect(note(player, a.id, "   ")).rejects.toThrow(/bad_text/);
    await expect(note(player, a.id, "x".repeat(1001))).rejects.toThrow(/bad_text/);
    await expect(t.as(player, "update developer_applications set notes = '[]' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
    await review(admin, a.id, false);
    await expect(note(admin, a.id, "one more thing")).rejects.toThrow(/closed/);
  });

  it("keeps at most 20 notes", async () => {
    const a = await apply(player);
    for (let i = 0; i < 20; i++) await note(i % 2 ? player : admin, a.id, `note ${i}`);
    await expect(note(admin, a.id, "21")).rejects.toThrow(/full/);
  });
});

describe("adding games, as before", () => {
  it("lets only developers add games, and shows them to everyone right away", async () => {
    await expect(t.as(player, "insert into games (slug, title, category, play_url, created_by) values ('player-game', 'x', 'arcade', 'https://x.example', $1)", [player.id])).rejects.toThrow(/row-level security/);
    const [g] = await t.as<{ id: string }>(creator, "insert into games (slug, title, category, play_url, created_by) values ('creator-game', 'x', 'arcade', 'https://x.example', $1) returning id", [creator.id]);
    expect(await t.as(null, "select id from games where id = $1", [g.id])).toHaveLength(1);
  });

  it("removed the review columns and functions", async () => {
    const cols = await t.admin<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'games' and column_name in ('status', 'pending_play_url', 'review_note')");
    expect(cols).toEqual([]);
    await expect(t.admin("select review_game(gen_random_uuid(), true, null)")).rejects.toThrow(/does not exist/);
  });
});
