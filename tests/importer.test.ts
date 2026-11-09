import { describe, expect, it } from "vitest";
import { guessEngine, importGame } from "../server/importer";

type Pages = Record<string, string>;
const getter = (pages: Pages) => async (url: string) => (url in pages ? { url, text: pages[url] } : null);

const ITCH = `<html><head><title>Moon Hop by Lu</title>
<meta property="og:title" content="Moon Hop by Lu"/>
<meta property="og:description" content="Hop across the moon &amp; collect stars."/>
<meta property="og:image" content="https://img.itch.zone/aW1n/315x250%23c/cover.png"/>
</head><body>
<div class="iframe_placeholder" data-iframe="&lt;iframe src=&quot;https://html-classic.itch.zone/html/123456/index.html&quot; allowfullscreen&gt;&lt;/iframe&gt;"></div>
<a href="https://img.itch.zone/aW1n/shot1.png" class="screenshot_lightbox"><img/></a>
<a href="https://img.itch.zone/aW1n/shot2.png" class="screenshot_lightbox"><img/></a>
<table><tr><td>Genre</td><td><a href="/games/genre-platformer">Platformer</a></td></tr>
<tr><td>Made with</td><td><a href="/x">Godot</a></td></tr></table>
</body></html>`;

describe("filling in a game from a link", () => {
  it("reads an itch.io page", async () => {
    const out = await importGame("https://lu.itch.io/moon-hop", getter({ "https://lu.itch.io/moon-hop": ITCH }));
    expect(out).toMatchObject({
      source: "itch",
      title: "Moon Hop",
      description: "Hop across the moon & collect stars.",
      play_url: "https://html-classic.itch.zone/html/123456/index.html",
      thumbnail_url: "https://img.itch.zone/aW1n/315x250%23c/cover.png",
      screenshots: ["https://img.itch.zone/aW1n/shot1.png", "https://img.itch.zone/aW1n/shot2.png"],
      category: "platformer",
      engine: "Godot",
    });
  });

  it("says so when an itch.io game can't be played in the browser", async () => {
    const page = "<html><meta property='og:title' content='Big Game by X'/><body>Download</body></html>";
    expect(await importGame("https://x.itch.io/big", getter({ "https://x.itch.io/big": page }))).toEqual({ error: "not_web" });
  });

  it("reads a GitHub repository and its toki.json", async () => {
    const out = await importGame("https://github.com/lu/moon-hop", getter({
      "https://api.github.com/repos/lu/moon-hop": JSON.stringify({
        name: "moon-hop", full_name: "lu/moon-hop", description: "A hopping game", homepage: "", has_pages: true, owner: { login: "Lu" }, topics: ["phaser", "puzzle-game"], language: "JavaScript",
      }),
      "https://raw.githubusercontent.com/lu/moon-hop/HEAD/toki.json": JSON.stringify({ title: "Moon Hop!", controls: "Space to jump" }),
    }));
    expect(out).toMatchObject({
      source: "github", repo: "lu/moon-hop", title: "Moon Hop!", description: "A hopping game", play_url: "https://lu.github.io/moon-hop/",
      engine: "Phaser", category: "puzzle", controls: "Space to jump",
    });
  });

  it("reads any page the game runs on", async () => {
    const html = `<title>Tiny Tanks</title><meta name="description" content="Tanks!"><meta property="og:image" content="/cover.png"><script src="Build/x.loader.js"></script><script>createUnityInstance()</script>`;
    const out = await importGame("https://tanks.example.com/play/", getter({ "https://tanks.example.com/play/": html }));
    expect(out).toMatchObject({ source: "page", title: "Tiny Tanks", description: "Tanks!", thumbnail_url: "https://tanks.example.com/cover.png", play_url: "https://tanks.example.com/play/", engine: "Unity", toki: null });
  });

  it("refuses odd links", async () => {
    expect(await importGame("javascript:alert(1)", getter({}))).toEqual({ error: "bad_url" });
    expect(await importGame("https://gone.example.com/", getter({}))).toEqual({ error: "unreachable" });
  });

  it("guesses engines", () => {
    expect(guessEngine("<script src='godot.js'>")).toBe("Godot");
    expect(guessEngine("<canvas>")).toBeNull();
  });
});
