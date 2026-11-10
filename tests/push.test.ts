import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../server/db";
import { inviteMessage, knownService, pushInvite, pushKeys, sendPush, type Device, type InvitePush, type PushKeys } from "../server/push";
import { decrypt } from "../server/secrets";

const b64url = (b: Buffer) => b.toString("base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
/** HKDF with one block of output, as push encryption uses it. */
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

/** A browser's side of a push subscription: its keys, and how it reads what arrives (RFC 8291). */
function device(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const read = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const keyLen = body[20];
    const sender = body.subarray(21, 21 + keyLen);
    const data = body.subarray(21 + keyLen);
    const ikm = hkdf(auth, ecdh.computeSecret(sender), Buffer.concat([Buffer.from("WebPush: info\0"), pub, sender]), 32);
    const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
    const d = createDecipheriv("aes-128-gcm", key, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    // The text ends at the last 0x02 (padding after it).
    return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
  };
  return { sub: { endpoint, p256dh: b64url(pub), auth: b64url(auth), lang: "en" } as Device, read };
}

const keys: PushKeys = { publicKey: "", privateKey: "" };
{
  const e = createECDH("prime256v1");
  keys.publicKey = b64url(e.generateKeys());
  keys.privateKey = b64url(e.getPrivateKey());
}
const invite: InvitePush = { from: "mia", title: "Apex", slug: "apex", code: "ABCD", party: "11111111-1111-4111-8111-111111111111", devices: null };

/** The few database calls the push code makes. */
function db(start: { secret?: string; push?: InvitePush | null } = {}) {
  const state = { secret: start.secret, removed: [] as string[], inserts: 0 };
  const api = {
    select: async () => (state.secret === undefined ? [] : [{ value: state.secret }]),
    insert: async (_table: string, row: { value: string }, prefer: string) => {
      state.inserts++;
      if (state.secret === undefined || prefer.includes("merge-duplicates")) state.secret = row.value;
      return [];
    },
    rpc: async () => start.push ?? null,
    remove: async (_table: string, query: string) => {
      state.removed.push(decodeURIComponent(query.replace("endpoint=eq.", "")));
      return null;
    },
  };
  return { db: api as unknown as Db, state };
}

describe("a pushed invite", () => {
  it("says who invites to what, and opens the room in the friend's party", () => {
    expect(inviteMessage(invite, "en")).toEqual({
      title: "Toki", body: "@mia invites you to play Apex", url: "/game/apex?room=ABCD&party=11111111-1111-4111-8111-111111111111", tag: "invite:mia",
    });
    expect(inviteMessage(invite, "de").body).toBe("@mia lädt dich zu Apex ein");
    expect(inviteMessage({ ...invite, party: null }, "en").url).toBe("/game/apex?room=ABCD");
    expect(inviteMessage({ ...invite, slug: null }, "en").url).toBe("/notifications"); // the game is gone
  });

  it("reaches the device signed and readable only by it", async () => {
    const d = device();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const message = inviteMessage(invite, "en");
    expect(await sendPush(d.sub, message, keys, fetchImpl)).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(d.sub.endpoint);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    expect(Number(headers.TTL)).toBeGreaterThan(60);
    const body = calls[0].init.body as unknown as Buffer;
    expect(body.toString("utf8")).not.toContain("mia");
    expect(JSON.parse(d.read(Buffer.from(body)))).toEqual(message);
    // Signed for that push service, by Toki.
    const claims = JSON.parse(Buffer.from(headers.Authorization.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://www.playtoki.app" });
  });

  it("tells a device that is gone from one that failed for now", async () => {
    const d = device();
    const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await sendPush(d.sub, inviteMessage(invite, "en"), keys, answer(410))).toBe("gone");
    expect(await sendPush(d.sub, inviteMessage(invite, "en"), keys, answer(404))).toBe("gone");
    expect(await sendPush(d.sub, inviteMessage(invite, "en"), keys, answer(500))).toBe("failed");
    expect(await sendPush(d.sub, inviteMessage(invite, "en"), keys, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe("failed");
    expect(await sendPush({ ...d.sub, p256dh: "nonsense" }, inviteMessage(invite, "en"), keys, answer(201))).toBe("failed");
  });

  it("is only ever sent to a browser's push service", async () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(knownService(ok)).toBe(true);
    }
    for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://evil.example/fcm.googleapis.com", "https://localhost/x", "https://10.0.0.1/x", "https://user@web.push.apple.com/x", "https://web.push.apple.com:8443/x", "not a link"]) {
      expect(knownService(bad)).toBe(false);
    }
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    expect(await sendPush(device("https://evil.example/hook").sub, inviteMessage(invite, "en"), keys, fetchImpl)).toBe("gone");
    expect(called).toBe(false);
  });

  it("goes to each of the friend's devices in its language, and forgets the ones that are gone", async () => {
    const phone = device("https://web.push.apple.com/phone");
    const old = device("https://fcm.googleapis.com/fcm/send/old");
    phone.sub.lang = "de";
    const { db: d, state } = db({ push: { ...invite, devices: [phone.sub, old.sub] } });
    const got: Record<string, Buffer> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      got[url] = Buffer.from(init.body as unknown as Buffer);
      return new Response(null, { status: url.includes("old") ? 410 : 201 });
    }) as unknown as typeof fetch;
    expect(await pushInvite(d, { serviceKey: "sk", push: keys }, "a", "b", fetchImpl)).toBe(1);
    expect(JSON.parse(phone.read(got[phone.sub.endpoint])).body).toBe("@mia lädt dich zu Apex ein");
    expect(state.removed).toEqual([old.sub.endpoint]);
    // Nothing to push (no fresh invite, the friend is on Toki, or has no device).
    expect(await pushInvite(db().db, { serviceKey: "sk", push: keys }, "a", "b", fetchImpl)).toBe(0);
  });
});

describe("the server's key pair for push", () => {
  const other: PushKeys = { publicKey: "P".repeat(87), privateKey: "s".repeat(43) };

  it("is made once and stored encrypted", async () => {
    const { db: d, state } = db();
    const first = await pushKeys(d, { serviceKey: "sk" }, () => keys);
    expect(first).toEqual(keys);
    expect(state.secret).not.toContain(keys.privateKey);
    expect(JSON.parse(decrypt(state.secret!, "sk")!)).toEqual(keys);
    expect(await pushKeys(d, { serviceKey: "sk" }, () => other)).toEqual(keys);
    expect(state.inserts).toBe(1);
  });

  it("stays the first one when two requests make one at the same time", async () => {
    const { db: d, state } = db();
    // Another request stored its pair between this one's look and its write.
    const winner = (await import("../server/secrets")).encrypt(JSON.stringify(other), "sk");
    const first = await pushKeys(d, { serviceKey: "sk" }, () => {
      state.secret = winner;
      return keys;
    });
    expect(first).toEqual(other);
  });

  it("is replaced when it can't be read any more, and a pair set in Vercel wins", async () => {
    const { db: d, state } = db({ secret: "v1:broken" });
    expect(await pushKeys(d, { serviceKey: "sk" }, () => keys)).toEqual(keys);
    expect(JSON.parse(decrypt(state.secret!, "sk")!)).toEqual(keys);
    expect(await pushKeys(d, { serviceKey: "sk", push: other }, () => keys)).toEqual(other);
    expect(await pushKeys(d, { serviceKey: "sk", push: { publicKey: "", privateKey: "" } }, () => other)).toEqual(keys);
  });
});
