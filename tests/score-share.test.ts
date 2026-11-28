import { describe, expect, it } from "vitest";
import { ordinal, scoreHeadline, stillImages, USERNAME } from "../server/score-share";
import { scoreSharePath } from "../src/lib/scoreFormat";
import { badgeCode } from "../src/components/TokiBadge";

describe("shared high scores", () => {
  it("links to the game with the player's name", () => {
    expect(scoreSharePath("apex", "das_leon")).toBe("/game/apex?by=das_leon#scores");
    expect(scoreSharePath("apex")).toBe("/game/apex#scores");
    expect(scoreSharePath("apex", null)).toBe("/game/apex#scores");
  });

  it("only looks up real usernames", () => {
    expect(USERNAME.test("das_leon")).toBe(true);
    expect(USERNAME.test("a.b-c_1")).toBe(true);
    expect(USERNAME.test("x'); drop")).toBe(false);
    expect(USERNAME.test("")).toBe(false);
  });

  it("says the place in English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });

  it("uses only pictures the card can draw", () => {
    expect(
      stillImages({
        screenshots: ["https://a.playtoki.app/1.png", "https://a.playtoki.app/2.webp", "http://insecure/3.jpg"],
        banner_url: "https://a.playtoki.app/banner.gif",
        thumbnail_url: "https://x.supabase.co/t.JPG",
      }),
    ).toEqual(["https://a.playtoki.app/1.png", "https://x.supabase.co/t.JPG"]);
  });

  it("writes the preview text", () => {
    const h = scoreHeadline({ slug: "apex", title: "Apex", username: "das_leon", score: 49899, shown: "0:49.899", rank: 2, images: [] });
    expect(h.title).toBe("@das_leon scored 0:49.899 in Apex");
    expect(h.description).toContain("2nd place");
  });
});

describe("Play on Toki button", () => {
  it("links the badge to the game", () => {
    const c = badgeCode("coastr");
    expect(c.html).toBe('<a href="https://playtoki.app/game/coastr"><img src="https://playtoki.app/badge.svg" alt="Play on Toki" height="44"></a>');
    expect(c.markdown).toBe("[![Play on Toki](https://playtoki.app/badge.svg)](https://playtoki.app/game/coastr)");
    expect(badgeCode("coastr", true).markdown).toContain("badge-light.svg");
  });
});
