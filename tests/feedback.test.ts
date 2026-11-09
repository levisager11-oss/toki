import { describe, expect, it } from "vitest";
import { ago, canManage, deviceSummary, errorKey, needsReply, similarPosts, summarize, type FeedbackPost } from "../src/lib/feedback";

const post = (over: Partial<FeedbackPost> = {}): FeedbackPost => ({
  id: crypto.randomUUID(), game_id: "g1", author_id: "u1", kind: "bug", title: "Jump does nothing", body: "", device: null,
  private: false, status: "open", hidden: false, answered: false, vote_count: 0, reply_count: 0,
  created_at: "2026-11-01T10:00:00Z", edited_at: null, status_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z",
  author: { username: "levi", role: "player" }, game: { slug: "deep-sub", title: "Deep Sub", created_by: "dev" }, ...over,
});

describe("deviceSummary", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "Safari 18 · iOS 18.1 · 390×844"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1", "Chrome 130 · iOS 17.4 · 390×844"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome 130 · Android 14 · 390×844"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge 130 · Windows · 390×844"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox 132 · macOS · 390×844"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "Safari 18 · macOS · 390×844"],
  ])("describes %s", (ua, want) => expect(deviceSummary(ua, 390, 844)).toBe(want));

  it("leaves out what it doesn't know", () => {
    expect(deviceSummary("SomeBot/1.0")).toBe("");
    expect(deviceSummary("Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0")).toBe("Firefox 130 · Linux");
  });
  it("stays short", () => expect(deviceSummary("x".repeat(500), 1, 1).length).toBeLessThanOrEqual(200));
});

describe("similarPosts", () => {
  const posts = [
    post({ title: "Jump does nothing on iPhone", vote_count: 3 }),
    post({ title: "Sound keeps playing after closing", vote_count: 9 }),
    post({ title: "Add a jump button for touch screens", vote_count: 1 }),
    post({ title: "Sprung geht nicht auf dem Handy" }),
  ];
  it("finds posts that share words, best match first", () => {
    expect(similarPosts("jump broken on iphone", posts).map((p) => p.title)).toEqual(["Jump does nothing on iPhone", "Add a jump button for touch screens"]);
  });
  it("ignores case, punctuation and filler words", () => {
    expect(similarPosts("SOUND!!!", posts).map((p) => p.title)).toEqual(["Sound keeps playing after closing"]);
    expect(similarPosts("the game does not", posts)).toEqual([]);
  });
  it("works for German", () => expect(similarPosts("Sprung kaputt", posts)).toHaveLength(1));
  it("returns nothing for an empty title", () => expect(similarPosts("  ", posts)).toEqual([]));
});

describe("dashboard", () => {
  it("knows which posts wait for a reply", () => {
    expect(needsReply(post())).toBe(true);
    expect(needsReply(post({ answered: true }))).toBe(false);
    expect(needsReply(post({ status: "done" }))).toBe(false);
    expect(needsReply(post({ hidden: true }))).toBe(false);
  });
  it("counts open bugs, open ideas and done posts, without hidden ones", () => {
    const s = summarize([
      post(), post({ status: "planned" }), post({ kind: "idea" }), post({ kind: "idea", status: "done", answered: true }),
      post({ status: "declined" }), post({ hidden: true }), post({ kind: "other", answered: true }),
    ]);
    expect(s).toEqual({ needsReply: 3, bugs: 2, ideas: 1, done: 1 });
  });
  it("lets the game's developer and admins manage a post", () => {
    expect(canManage(post(), { id: "dev", role: "creator" })).toBe(true);
    expect(canManage(post(), { id: "other", role: "creator" })).toBe(false);
    expect(canManage(post(), { id: "x", role: "admin" })).toBe(true);
    expect(canManage(post({ game: null, game_id: null }), { id: "dev", role: "creator" })).toBe(false);
    expect(canManage(post({ game: null, game_id: null }), { id: "x", role: "admin" })).toBe(true);
    expect(canManage(post(), null)).toBe(false);
  });
});

describe("errorKey", () => {
  it("explains the limit and short titles", () => {
    expect(errorKey({ message: "rate_limited" })).toBe("fb.err.rateLimited");
    expect(errorKey({ code: "23514", message: "violates check constraint" })).toBe("fb.err.tooShort");
    expect(errorKey({ message: "network" })).toBe("error");
    expect(errorKey(null)).toBe("error");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  it("says how long ago", () => {
    expect(ago("2026-11-09T11:59:40Z", "en", now)).toBe("now");
    expect(ago("2026-11-09T11:30:00Z", "en", now)).toBe("30 minutes ago");
    expect(ago("2026-11-09T09:00:00Z", "en", now)).toBe("3 hours ago");
    expect(ago("2026-11-08T12:00:00Z", "en", now)).toBe("yesterday");
    expect(ago("2026-11-08T12:00:00Z", "de", now)).toBe("gestern");
  });
  it("shows a date for old posts", () => expect(ago("2026-01-15T12:00:00Z", "en", now)).toMatch(/2026/));
});
