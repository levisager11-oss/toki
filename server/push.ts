// Push notifications for game invites (Web Push): a friend who isn't on Toki gets the invite on
// the devices where they turned that on. Rules: supabase/migrations/20261122100000_push.sql.
//
// Push services only take messages signed with the sender's key pair. Toki makes its pair the
// first time it is needed and keeps it with the other server secrets (encrypted); a pair set
// in Vercel (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) wins.
import webpush from "web-push";
import { joinPath } from "../src/lib/invites.js";
import type { Db } from "./db.js";
import type { ServerEnv } from "./env.js";
import { decrypt, encrypt } from "./secrets.js";

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}

export interface Device {
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: string;
}

/** What take_invite_push hands over: the invite, and the friend's devices. */
export interface InvitePush {
  from: string;
  title: string;
  slug: string | null;
  code: string;
  party: string | null;
  devices: Device[] | null;
}

const validKeys = (k: Partial<PushKeys> | null | undefined): k is PushKeys => !!k && typeof k.publicKey === "string" && typeof k.privateKey === "string" && k.publicKey.length > 60 && k.privateKey.length > 30;

export async function pushKeys(db: Db, env: Pick<ServerEnv, "serviceKey" | "push">, make: () => PushKeys = () => webpush.generateVAPIDKeys()): Promise<PushKeys> {
  if (validKeys(env.push)) return env.push;
  const read = async (): Promise<{ stored: boolean; keys: PushKeys | null }> => {
    const [row] = await db.select<{ value: string }>("server_secrets", "name=eq.web_push&select=value");
    if (!row) return { stored: false, keys: null };
    try {
      const k = JSON.parse(decrypt(row.value, env.serviceKey) ?? "null") as Partial<PushKeys> | null;
      return { stored: true, keys: validKeys(k) ? k : null };
    } catch {
      return { stored: true, keys: null };
    }
  };
  const have = await read();
  if (have.keys) return have.keys;
  const made = make();
  // Two requests at once: the first pair stays. A stored pair that can't be read any more
  // (the Supabase secret key changed) is replaced; devices then have to turn invites on again.
  await db.insert(
    "server_secrets?on_conflict=name",
    { name: "web_push", value: encrypt(JSON.stringify(made), env.serviceKey), updated_at: new Date().toISOString() },
    `resolution=${have.stored ? "merge" : "ignore"}-duplicates,return=minimal`,
  );
  return (await read()).keys ?? made;
}

/** The push services browsers use. Devices name the address to send to, so only these are called. */
const SERVICES = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com|([a-z0-9-]+\.)*push\.apple\.com)$/;
export function knownService(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.port && SERVICES.test(u.hostname);
  } catch {
    return false;
  }
}

export interface PushMessage {
  title: string;
  body: string;
  /** The page on Toki a tap opens. */
  url: string;
  /** A newer invite from the same friend replaces the earlier notification. */
  tag: string;
}

export function inviteMessage(p: Pick<InvitePush, "from" | "title" | "slug" | "code" | "party">, lang: string): PushMessage {
  const who = `@${p.from}`;
  return {
    title: "Toki",
    body: lang === "de" ? `${who} lädt dich zu ${p.title} ein` : `${who} invites you to play ${p.title}`,
    url: p.slug ? joinPath(p.slug, p.code, p.party) : "/notifications",
    tag: `invite:${p.from}`,
  };
}

// An invite is good for half an hour; a phone that was offline longer doesn't need it any more.
const TTL_SECONDS = 20 * 60;

/** "gone": the device doesn't take messages any more (or was never a real one), so it can be deleted. */
export async function sendPush(device: Device, message: PushMessage, keys: PushKeys, fetchImpl: typeof fetch = fetch): Promise<"sent" | "gone" | "failed"> {
  if (!knownService(device.endpoint)) return "gone";
  try {
    const req = webpush.generateRequestDetails(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(message),
      { vapidDetails: { subject: "https://www.playtoki.app", ...keys }, TTL: TTL_SECONDS, urgency: "high", contentEncoding: "aes128gcm" },
    );
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase() !== "content-length") headers[k] = String(v);
    const res = await fetchImpl(req.endpoint, { method: "POST", headers, body: req.body as unknown as BodyInit, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return "sent";
    // 404/410: unsubscribed. 403: subscribed with another key pair than the server's.
    return res.status === 404 || res.status === 410 || res.status === 403 ? "gone" : "failed";
  } catch {
    // Also keys a device made up: nothing can be encrypted for them.
    return "failed";
  }
}

/** Pushes the invite p_from just sent to p_to, if there is one to push. Returns how many devices got it. */
export async function pushInvite(db: Db, env: Pick<ServerEnv, "serviceKey" | "push">, from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const push = await db.rpc<InvitePush | null>("take_invite_push", { p_from: from, p_to: to });
  if (!push?.devices?.length) return 0;
  const keys = await pushKeys(db, env);
  const results = await Promise.all(push.devices.map((d) => sendPush(d, inviteMessage(push, d.lang), keys, fetchImpl)));
  await Promise.all(push.devices.map((d, i) =>
    results[i] === "gone" ? db.remove("push_subscriptions", `endpoint=eq.${encodeURIComponent(d.endpoint)}`).catch(() => {}) : null));
  return results.filter((r) => r === "sent").length;
}
