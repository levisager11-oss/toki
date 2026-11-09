import { describe, expect, it } from "vitest";
import { filePath, siteFrom, typeOf } from "../cloudflare/games-worker/lib.js";
import { RESERVED_SITES } from "../src/lib/hostingRules";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reserved = new Set(["www", "api"]);

describe("games Worker", () => {
  it("finds the game from the address", () => {
    expect(siteFrom("snake.playtoki.app", "playtoki.app", reserved)).toBe("snake");
    expect(siteFrom("Snake.PlayToki.app", "playtoki.app", reserved)).toBe("snake");
    expect(siteFrom("www.playtoki.app", "playtoki.app", reserved)).toBeNull();
    expect(siteFrom("playtoki.app", "playtoki.app", reserved)).toBeNull();
    expect(siteFrom("a.b.playtoki.app", "playtoki.app", reserved)).toBeNull();
    expect(siteFrom("snake.example.com", "playtoki.app", reserved)).toBeNull();
  });

  it("serves only files inside the game", () => {
    expect(filePath("/")).toBe("index.html");
    expect(filePath("/levels/")).toBe("levels/index.html");
    expect(filePath("/My%20Game.html")).toBe("My Game.html");
    expect(filePath("/a/../../b")).toBeNull();
    expect(filePath("/%2e%2e/x")).toBeNull();
    expect(filePath("/%E0%A4%A")).toBeNull();
  });

  it("sends Unity's compressed files the way the browser expects", () => {
    expect(typeOf("Build/game.wasm.br")).toEqual({ type: "application/wasm", encoding: "br" });
    expect(typeOf("Build/game.data.gz")).toEqual({ type: "application/octet-stream", encoding: "gzip" });
    expect(typeOf("index.html")).toEqual({ type: "text/html; charset=utf-8", encoding: null });
    expect(typeOf("game.pck")).toEqual({ type: "application/octet-stream", encoding: null });
    expect(typeOf("LICENSE")).toEqual({ type: "application/octet-stream", encoding: null });
  });

  it("knows the same reserved names as Toki", () => {
    const toml = readFileSync(join(import.meta.dirname, "..", "cloudflare", "games-worker", "wrangler.toml"), "utf8");
    const list = /RESERVED = "([^"]*)"/.exec(toml)![1].split(",");
    expect(new Set(list)).toEqual(RESERVED_SITES);
  });
});
