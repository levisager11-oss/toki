// Push notifications for game invites: a friend who isn't on Toki right now gets the invite on
// this device, if they turned it on here. Only invites are pushed. The service worker
// (public/sw.js) shows them; the server (api/push.ts) sends them.
// Rules: supabase/migrations/20261122100000_push.sql.
import { api } from "./ai";
import { supabase } from "./supabase";

/**
 * "install": an iPhone or iPad, where notifications only work for Toki on the Home Screen.
 * "blocked": the player said no in the browser, and only they can change that there.
 */
export type PushState = "unsupported" | "install" | "blocked" | "off" | "on";

const SW = "/sw.js";

function support(): "ok" | "install" | "unsupported" {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "unsupported";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return apple && !installed ? "install" : "unsupported";
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  const s = support();
  if (s !== "ok") return s;
  if (Notification.permission === "denied") return "blocked";
  try {
    return Notification.permission === "granted" && (await subscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** The server's public key, as the browser wants it. */
function keyBytes(key: string): Uint8Array {
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function save(sub: PushSubscription, lang: string): Promise<void> {
  const j = sub.toJSON();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_lang: lang,
  });
  if (error) throw new Error(error.message);
}

/** Asks the player (the browser's own question) and turns invites on for this device. */
export async function enablePush(userId: string, lang: string): Promise<PushState> {
  const s = support();
  if (s !== "ok") return s;
  // First thing after the tap: some browsers only ask when nothing came in between.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "off";
  const reg = await navigator.serviceWorker.register(SW);
  await navigator.serviceWorker.ready;
  const { key } = await api<{ key: string }>("/api/push");
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(key) };
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(options);
  } catch {
    // Subscribed with an older key of the server: start over.
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  await save(sub, lang);
  remember(userId, lang);
  return "on";
}

export async function disablePush(): Promise<void> {
  if (support() !== "ok") return;
  const sub = await subscription().catch(() => null);
  if (!sub) return;
  await supabase.rpc("remove_push_subscription", { p_endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}

const SEEN = "toki.push.seen";
const WEEK_MS = 7 * 24 * 3600_000;
function remember(userId: string, lang: string) {
  try {
    localStorage.setItem(SEEN, `${Date.now()}|${userId}|${lang}`);
  } catch {
    /* no storage: it is just said again next time */
  }
}

/**
 * Once a week, and when another account logs in on this device or the language changes: tells
 * the server this device still wants invites, for whoever is logged in now.
 */
export async function keepPush(userId: string, lang: string): Promise<void> {
  if (support() !== "ok" || Notification.permission !== "granted") return;
  let last = "";
  try {
    last = localStorage.getItem(SEEN) ?? "";
  } catch {
    /* no storage */
  }
  const [at, who, shown] = last.split("|");
  if (who === userId && shown === lang && Date.now() - Number(at) < WEEK_MS) return;
  const sub = await subscription().catch(() => null);
  if (!sub) return;
  await save(sub, lang).then(() => remember(userId, lang), () => {});
}

/**
 * Logging out: this device stops getting the account's invites. The browser's permission
 * stays, so whoever logs in here next gets theirs (keepPush).
 */
export async function forgetPush(): Promise<void> {
  if (support() !== "ok") return;
  try {
    localStorage.removeItem(SEEN);
  } catch {
    /* no storage */
  }
  const sub = await subscription().catch(() => null);
  if (sub) await supabase.rpc("remove_push_subscription", { p_endpoint: sub.endpoint });
}

/** After inviting a friend: the server pushes the invite to their devices, if they aren't on Toki. */
export function pushInvite(friendId: string): void {
  api("/api/push", { method: "POST", body: JSON.stringify({ to: friendId }) }).catch(() => {});
}
