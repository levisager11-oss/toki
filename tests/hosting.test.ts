import { describe, expect, it } from "vitest";
import { presign, signHeaders } from "../server/r2";
import { cleanPath, isHostedUrl, isSmallVersion, MAX_GAME_BYTES, planFiles, readTokiJson, siteFor, siteUrl } from "../src/lib/hostingRules";
import { hashKey, isUploadKey, newKey } from "../server/hosting";

// The examples from AWS's Signature Version 4 documentation for S3.
const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") };

describe("signing for Cloudflare R2", () => {
  it("makes the same presigned link as AWS's example", () => {
    const url = presign({ ...AWS, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", expires: 86400 });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs a request the way AWS's example does", () => {
    const h = signHeaders({ ...AWS, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" } });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("locks an upload link to the file's size", () => {
    const url = presign({ ...AWS, method: "PUT", host: "x.r2.cloudflarestorage.com", path: "/games/b/1/index.html", headers: { "content-length": "12" }, expires: 3600 });
    expect(url).toContain("X-Amz-SignedHeaders=content-length%3Bhost");
  });
});

describe("files of a hosted game", () => {
  it("cleans up paths and refuses tricks", () => {
    expect(cleanPath("./game/index.html")).toBe("game/index.html");
    expect(cleanPath("game\\data.pck")).toBe("game/data.pck");
    expect(cleanPath("../secret")).toBeNull();
    expect(cleanPath("a//b")).toBeNull();
    expect(cleanPath("__MACOSX/._index.html")).toBeNull();
    expect(cleanPath("assets/.DS_Store")).toBeNull();
  });

  it("drops the folder a ZIP was made of", () => {
    const plan = planFiles([{ path: "MyGame/index.html", size: 10 }, { path: "MyGame/game.wasm", size: 20 }, { path: "__MACOSX/MyGame/x", size: 1 }]);
    expect(plan).toMatchObject({ entry: "index.html", bytes: 30, files: [{ path: "index.html" }, { path: "game.wasm" }] });
  });

  it("finds the game's page when there is no index.html", () => {
    expect(planFiles([{ path: "Snake.html", size: 5 }])).toMatchObject({ entry: "Snake.html" });
    expect(planFiles([{ path: "a.html", size: 5 }, { path: "b.html", size: 5 }])).toEqual({ error: "no_entry" });
    expect(planFiles([{ path: "web/start.html", size: 5 }, { path: "web/x.js", size: 5 }], "start.html")).toMatchObject({ entry: "start.html" });
  });

  it("keeps games under 100 MB", () => {
    expect(planFiles([{ path: "index.html", size: MAX_GAME_BYTES + 1 }])).toEqual({ error: "too_big" });
    expect(planFiles([])).toEqual({ error: "no_files" });
    expect(planFiles([{ path: "index.html", size: -1 }])).toEqual({ error: "bad_file" });
  });
});

describe("game addresses", () => {
  it("uses the slug, but never one of Toki's own names", () => {
    expect(siteFor("snake")).toBe("snake");
    expect(siteFor("www")).toBe("www-game");
    expect(siteFor("snake", 1)).toMatch(/^snake-[a-z0-9]{4}$/);
    expect(siteUrl("snake", "playtoki.app")).toBe("https://snake.playtoki.app/");
    expect(siteUrl("snake", "playtoki.app", "My Game.html")).toBe("https://snake.playtoki.app/My%20Game.html");
  });

  it("tells hosted links from others", () => {
    expect(isHostedUrl("https://snake.playtoki.app/", "playtoki.app")).toBe(true);
    expect(isHostedUrl("https://www.playtoki.app/game/snake", "playtoki.app")).toBe(true);
    expect(isHostedUrl("https://a.b.playtoki.app/", "playtoki.app")).toBe(false);
    expect(isHostedUrl("https://snake.vercel.app/", "playtoki.app")).toBe(false);
  });
});

describe("toki.json", () => {
  it("takes what it knows and leaves out the rest", () => {
    const t = readTokiJson(JSON.stringify({ title: " Snake ", category: "Arcade", version: 1.2, notes: ["Faster snake", "- New level"], screenshots: ["a.png", 3], isolation: true, extra: 1, category2: "x" }));
    expect(t).toEqual({ title: "Snake", category: "arcade", version: "1.2", notes: "- Faster snake\n- New level", screenshots: ["a.png"], isolation: true });
    expect(readTokiJson("not json")).toEqual({});
    expect(readTokiJson({ category: "cooking", slug: "Bad Slug!" })).toEqual({});
  });

  it("knows small fixes", () => {
    expect(isSmallVersion("1.2.1")).toBe(true);
    expect(isSmallVersion("1.2")).toBe(false);
    expect(isSmallVersion("1.2.0")).toBe(false);
  });
});

describe("upload keys", () => {
  it("are long, random and stored only as a hash", () => {
    const k = newKey();
    expect(isUploadKey(k)).toBe(true);
    expect(newKey()).not.toBe(k);
    expect(hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(isUploadKey("toki_short")).toBe(false);
  });
});
