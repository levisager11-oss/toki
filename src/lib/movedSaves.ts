// Players' progress comes along when a game moves to Toki (server/migrate.ts). A game keeps its
// progress in the browser under its own address, and the game's new address can't read the old
// one. But at the old address the game has Toki's save script, which hands everything it stored
// to Toki when asked. So the first time a player who played the game on Toki before opens it
// after the move, Toki opens the old address hidden, takes the progress from there and keeps it
// as this device's save of the game. Then the game starts at its new address and gets it, through
// the usual save steps (src/lib/saves.ts): for logged-in players it also goes into the account,
// and if the account has a save already, that one stays and this one is kept as a copy to restore.
import { asSave, readRecord, writeRecord, type KeyValue, type SaveData } from "./saves";
import type { Game } from "./types";

/** Progress is picked up at the old address this long after the move. */
export const PICKUP_DAYS = 180;
/** How long the old address may take to answer (its page loads, the save script says hello). */
export const HELLO_MS = 12_000;
/** After answering: how long the game there may take to hand over what it stored. */
export const STORE_MS = 2500;

const doneKey = (gameId: string) => `toki.moved.${gameId}`;
const origin = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
};

const has = (kv: KeyValue, key: string) => {
  try {
    return kv.get(key) !== null;
  } catch {
    return false;
  }
};
const inList = (kv: KeyValue, key: string, slug: string) => readList(kv, key).includes(slug);
/** A list of game addresses kept in this browser (recently played, favorites). */
export function readList(kv: KeyValue, key: string): string[] {
  try {
    const v = JSON.parse(kv.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Whether to fetch this player's progress from the game's old address before it starts: the game
 * moved (not too long ago), this device played it on Toki before (recently played, a favorite, or
 * the game sent a save), and Toki keeps no save of it on this device yet. `recent`: this device's
 * recently played games from before the game page opened (it marks the game as played).
 */
export function needsPickup(game: Pick<Game, "id" | "slug" | "play_url" | "moved_from" | "moved_at">, userId: string | undefined, kv: KeyValue, recent: string[], now = Date.now()): boolean {
  const from = origin(game.moved_from);
  if (!from || from === origin(game.play_url)) return false;
  const at = game.moved_at ? Date.parse(game.moved_at) : NaN;
  if (!Number.isFinite(at) || now - at > PICKUP_DAYS * 86400_000) return false;
  if (has(kv, doneKey(game.id))) return false;
  if (readRecord(kv, userId ?? "anon", game.id) || readRecord(kv, "anon", game.id)) return false;
  return recent.includes(game.slug) || inList(kv, "toki.favorites", game.slug) || has(kv, `toki.save.game.${game.id}`);
}

/** Done for this game on this device, whatever came of it, so it isn't asked again. */
export function markPickedUp(kv: KeyValue, gameId: string) {
  try {
    kv.set(doneKey(gameId), String(Date.now()));
  } catch {
    /* storage blocked: then nothing was kept on this device anyway */
  }
}

/** Keeps the progress from the old address as this device's save of the game (unless one appeared meanwhile). */
export function keepPickedUp(kv: KeyValue, gameId: string, userId: string | undefined, raw: unknown): SaveData | null {
  const save = asSave(raw);
  if (!save || !Object.keys(save.keys).length) return null;
  const who = userId ?? "anon";
  if (readRecord(kv, who, gameId)) return null;
  writeRecord(kv, who, gameId, { save, bases: [], dirty: true });
  return save;
}

/**
 * Talks to the game at its old address in a hidden frame: answers its "hello" with "no save here",
 * so the save script hands over what it stored. Calls done() once it has it, or when the old
 * address doesn't answer in time. Returns a function that stops listening.
 */
export function listenForPickup(o: {
  frame: () => Window | null | undefined;
  from: string;
  gameId: string;
  userId: string | undefined;
  kv: KeyValue;
  done: (picked: boolean) => void;
}): () => void {
  const from = origin(o.from);
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  const finish = (picked: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    markPickedUp(o.kv, o.gameId);
    o.done(picked);
  };
  const onMessage = (e: MessageEvent) => {
    const win = o.frame();
    if (!win || e.source !== win || e.origin !== from) return;
    const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
    if (!m || m.toki !== 1) return;
    if (m.type === "hello") {
      win.postMessage({ toki: 1, type: "save", data: null }, from!);
      // The script hands over its storage only when there is some: if nothing comes, there's no progress.
      clearTimeout(timer);
      timer = setTimeout(() => finish(false), STORE_MS);
    } else if (m.type === "store") {
      finish(!!keepPickedUp(o.kv, o.gameId, o.userId, m.data));
    }
  };
  if (!from) {
    finish(false);
    return () => {};
  }
  window.addEventListener("message", onMessage);
  timer = setTimeout(() => finish(false), HELLO_MS);
  return () => {
    finished = true;
    clearTimeout(timer);
    window.removeEventListener("message", onMessage);
  };
}
