import { describe, expect, it } from "vitest";
import { sweepPictures } from "../server/pictures";
import type { Db } from "../server/db";

describe("deleting unused pictures", () => {
  it("deletes what the database lists, per bucket, with the server's key", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const db = {
      rpc: async () => [
        { bucket: "thumbnails", name: "a/1.webp" },
        { bucket: "avatars", name: "a/me.webp" },
        { bucket: "thumbnails", name: "b/2.png" },
      ],
    } as unknown as Db;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response("[]");
    }) as unknown as typeof fetch;
    expect(await sweepPictures(db, "sb_secret_x", 50, fetchImpl)).toEqual({ pictures: 3 });
    expect(calls.map((c) => [c.url.split("/storage/v1/object/")[1], c.body])).toEqual([
      ["thumbnails", { prefixes: ["a/1.webp", "b/2.png"] }],
      ["avatars", { prefixes: ["a/me.webp"] }],
    ]);
    expect(calls[0].headers.apikey).toBe("sb_secret_x");
  });

  it("stops when storage refuses", async () => {
    const db = { rpc: async () => [{ bucket: "avatars", name: "x" }] } as unknown as Db;
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(sweepPictures(db, "k", 10, fetchImpl)).rejects.toThrow(/403/);
  });
});
