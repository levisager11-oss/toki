// Game saves. Games run on their own sites inside Toki's frame, and iPhones delete storage of
// sites shown inside other sites when the app closes. Games that include /toki-save.js send
// their saves here: Toki keeps them on this device and, for logged-in players, in the account.
//
// The game script (already shipped in games, so it can't change) trusts the newest "t": it
// takes Toki's save only when it is newer than its own. So Toki decides what the game gets:
// - For logged-in players, "hello" is answered only once the account save is loaded or known
//   to be missing, never with "nothing" while it is still loading.
// - When the account copy should win, Toki hands it over with a fresh "t", so the game takes it.
// - Each save goes up with the account versions this device built on ("bases"). The server
//   only lets it replace the account copy when it was made on top of it; otherwise the account
//   copy stays and the other save is kept as a conflict copy (see put_game_save in schema.sql).
// - A game puts Toki's save back and reloads. With the first script version, a game that saves
//   on its own right then (autosave, saving on close) writes its fresh state over it. When the
//   game's first save after such a reload is far smaller than what it was given, Toki doesn't
//   let it replace the progress ("lost"): it stays a backup, and the player can load again.
import { useEffect, useRef, useState, type RefObject } from "react";
import { supabase } from "./supabase";
import { visitorId } from "./local";

export interface SaveData {
  keys: Record<string, string>;
  /** When the game made this save (ms since 1970, from the game's clock). */
  t: number;
}

/** What this device knows about a game's save. */
export interface LocalRecord {
  save: SaveData;
  /** "t" of the account versions this save was made on top of. Empty: none known. */
  bases: number[];
  /** Not in the account yet. */
  dirty: boolean;
}

export interface Cloud {
  /** The account save, or null if there is none. Throws when it can't tell (offline, slow). */
  read(gameId: string): Promise<SaveData | null>;
  /** ok: it is the account save now. Otherwise current is the account save that was kept. Throws on network errors. */
  put(gameId: string, save: SaveData, bases: number[], device: string): Promise<{ ok: boolean; current: SaveData | null }>;
}

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const MAX_BYTES = 1_000_000;
const MAX_BASES = 20;
/** Logged-in "hello" with a copy on this device: answer from it if the account doesn't answer by then. */
export const ANSWER_DEADLINE_MS = 6000;
/** Saves go up after the game has been quiet this long. */
export const CLOUD_WAIT_MS = 2000;
/**
 * At most one upload per this long while playing (closing or hiding the page sends at once).
 * Many games save every few seconds; uploading each would mean over 1000 database writes an hour.
 */
export const UPLOAD_GAP_MS = 30_000;
const READ_TIMEOUT_MS = 15_000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];
/** A "hello" this soon after Toki gave a save comes from the game reloading to put it back. */
const RELOAD_WINDOW_MS = 30_000;

const size = (keys: Record<string, string>) => JSON.stringify(keys).length;

/** Whether two saves hold exactly the same keys and values. */
export function sameKeys(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** Checks a save sent by a game. Returns null if it isn't one. */
export function asSave(v: unknown): SaveData | null {
  if (!v || typeof v !== "object") return null;
  const { keys, t } = v as Partial<SaveData>;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || !keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  for (const val of Object.values(keys)) if (typeof val !== "string") return null;
  if (JSON.stringify(keys).length > MAX_BYTES) return null;
  return { keys: { ...keys }, t };
}

export function newest(...saves: (SaveData | null | undefined)[]): SaveData | null {
  return saves.reduce<SaveData | null>((best, s) => (s && (!best || s.t > best.t) ? s : best), null);
}

const localKey = (who: string, gameId: string) => `toki.save.${who}.${gameId}`;

/** Reads this device's record. Older versions of Toki stored the bare save. */
export function readRecord(kv: KeyValue, who: string, gameId: string): LocalRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(kv.get(localKey(who, gameId)) ?? "null");
  } catch {
    return null;
  }
  const legacy = asSave(v);
  if (legacy) return { save: legacy, bases: [legacy.t], dirty: true };
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<LocalRecord>;
  const save = asSave(r.save);
  if (!save) return null;
  const bases = Array.isArray(r.bases) ? r.bases.filter((b): b is number => typeof b === "number" && Number.isFinite(b)) : [];
  return { save, bases, dirty: r.dirty !== false };
}

export function writeRecord(kv: KeyValue, who: string, gameId: string, rec: LocalRecord) {
  try {
    kv.set(localKey(who, gameId), JSON.stringify(rec));
  } catch {
    /* storage full or blocked: the account copy still works for logged-in players */
  }
}

export interface SaveSyncOptions {
  gameId: string;
  /** Logged-in player, or undefined for visitors (saves stay on this device). */
  userId?: string;
  cloud: Cloud;
  kv: KeyValue;
  device: string;
  /** Sends Toki's answer to the game's "hello". */
  answer: (save: SaveData | null) => void;
  /** The account has progress this game page doesn't show (made on another device). */
  onConflict?: (conflict: boolean) => void;
  /** The game didn't keep the save it was given and started fresh (see above). */
  onLost?: (lost: boolean) => void;
  now?: () => number;
}

type CloudState = { known: false } | { known: true; save: SaveData | null };

/** Keeps one game's save in sync for one player on this page. */
export class SaveSync {
  private o: SaveSyncOptions & Required<Pick<SaveSyncOptions, "onConflict" | "onLost" | "now">>;
  private cloud: CloudState = { known: false };
  private waitingHello = false;
  private stopped = false;
  private loading = false;
  private uploading = false;
  private again = false;
  private conflict = false;
  private lost = false;
  /** The last save handed to the game, and when. */
  private given: { save: SaveData; at: number } | null = null;
  /** The save the game should be running on after reloading, checked against its first save. */
  private expected: SaveData | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private uploadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastUpload = -Infinity;

  constructor(opts: SaveSyncOptions) {
    this.o = { onConflict: () => {}, onLost: () => {}, now: Date.now, ...opts };
    if (this.o.userId) this.loadCloud(0);
  }

  private get who() {
    return this.o.userId ?? "anon";
  }
  private rec() {
    return readRecord(this.o.kv, this.who, this.o.gameId);
  }
  private setRec(rec: LocalRecord) {
    writeRecord(this.o.kv, this.who, this.o.gameId, rec);
  }
  private later(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }
  private setConflict(c: boolean) {
    if (this.conflict === c) return;
    this.conflict = c;
    this.o.onConflict(c);
  }
  private setLost(l: boolean) {
    if (this.lost === l) return;
    this.lost = l;
    this.o.onLost(l);
  }
  private send(save: SaveData | null) {
    if (save) {
      this.given = { save, at: this.o.now() };
      this.setLost(false);
    }
    this.o.answer(save);
  }

  /** The game asks for its save. */
  hello() {
    if (this.stopped) return;
    const g = this.given;
    this.expected = g && this.o.now() - g.at < RELOAD_WINDOW_MS ? g.save : null;
    if (!this.o.userId) {
      const save = this.rec()?.save ?? null;
      if (save) this.setGameT(save.t); // the game takes it when it is newer than its own
      this.send(save);
      return;
    }
    if (this.cloud.known) return this.answerFromCloud(this.cloud.save);
    this.waitingHello = true;
    // Without the account save we never answer "nothing": the game would take its own fresh
    // save as the newest. With a copy on this device, play can go on from it.
    this.later(() => {
      const rec = this.rec();
      if (this.waitingHello && !this.cloud.known && rec) {
        this.waitingHello = false;
        this.give(rec);
      }
    }, ANSWER_DEADLINE_MS);
  }

  /** The game saved. */
  store(save: SaveData) {
    if (this.stopped) return;
    const expected = this.expected;
    this.expected = null;
    if (expected && size(save.keys) * 2 < size(expected.keys)) this.setLost(true);
    const rec = this.rec();
    this.setGameT(save.t);
    if (!this.o.userId) {
      if (!this.lost) this.setRec({ save, bases: [], dirty: false });
      // Lost: the saved progress stays, newer than the game's, so the game takes it next time.
      else if (rec) this.setRec({ ...rec, save: { keys: rec.save.keys, t: save.t + 1 } });
      return;
    }
    // Lost: not built on the account save, so it goes up as a backup and doesn't replace it.
    this.setRec({ save, bases: this.lost ? [] : rec?.bases ?? [], dirty: true });
    clearTimeout(this.uploadTimer);
    const wait = Math.max(CLOUD_WAIT_MS, this.lastUpload + UPLOAD_GAP_MS - this.o.now());
    this.uploadTimer = this.later(() => this.upload(), wait);
  }

  /** Sends a waiting save now (the page is closing or hidden). */
  flush() {
    if (this.stopped) return;
    clearTimeout(this.uploadTimer);
    this.upload();
  }

  /** No more account traffic from this page (logout, or the game page closed). */
  stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  private loadCloud(attempt: number) {
    if (this.loading || this.stopped) return;
    this.loading = true;
    this.o.cloud.read(this.o.gameId).then(
      (save) => {
        this.loading = false;
        if (this.stopped) return;
        this.cloud = { known: true, save };
        this.onCloudKnown(save);
      },
      () => {
        this.loading = false;
        this.later(() => this.loadCloud(attempt + 1), RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
      },
    );
  }

  private onCloudKnown(cloud: SaveData | null) {
    if (this.waitingHello) {
      this.waitingHello = false;
      this.answerFromCloud(cloud);
      return;
    }
    // Already answered from this device's copy (slow network) or not asked yet.
    const rec = this.rec();
    if (!cloud || !rec || rec.bases.includes(cloud.t)) {
      if (rec?.dirty) this.upload();
    } else {
      // This device's copy isn't built on the account save: keep the account copy.
      this.setConflict(true);
      if (rec.dirty) this.upload(); // kept by the server as a conflict copy
    }
  }

  private answerFromCloud(cloud: SaveData | null) {
    const rec = this.rec();
    this.setConflict(false);
    if (!cloud) {
      // No account save yet: this device's progress becomes it (also progress from before logging in).
      const found = rec ?? this.adoptAnon();
      const mine = found && { ...found, dirty: true };
      if (mine) this.setRec(mine);
      this.give(mine);
      if (mine) this.upload();
      return;
    }
    if (rec && rec.bases.includes(cloud.t)) {
      this.give(rec);
      if (rec.dirty) this.upload();
      return;
    }
    // The account copy wins. Progress only on this device is kept as a conflict copy first.
    const anon = readRecord(this.o.kv, "anon", this.o.gameId);
    if (rec?.dirty) this.putConflictCopy(rec.save, rec.bases);
    if (!rec && anon && anon.save.t !== cloud.t) this.putConflictCopy(anon.save, []);
    // A fresh "t" makes the game take it even if its own save looks newer.
    const t = Math.max(cloud.t, this.o.now(), this.gameT() + 1, (rec?.save.t ?? 0) + 1, (anon?.save.t ?? 0) + 1);
    this.give({ save: { keys: cloud.keys, t }, bases: [cloud.t], dirty: false }, true);
  }

  /**
   * Sends a save the game must use. The game keeps its own save when that looks newer, e.g.
   * progress from after logging out, or from another account on this device. Then the save
   * goes with a fresh "t", so the game takes it.
   */
  private give(rec: LocalRecord | null, changed = false) {
    if (!rec) return this.send(null);
    const gameT = this.gameT();
    if (gameT > rec.save.t) {
      rec = { ...rec, save: { keys: rec.save.keys, t: Math.max(this.o.now(), gameT + 1) } };
      changed = true;
    }
    if (changed) this.setRec(rec);
    this.setGameT(rec.save.t);
    this.send(rec.save);
  }

  /** The "t" of the save the game in the frame has on this device, as far as Toki knows. */
  private gameT(): number {
    return Number(this.o.kv.get(`toki.save.game.${this.o.gameId}`)) || 0;
  }
  private setGameT(t: number) {
    try {
      if (t > this.gameT()) this.o.kv.set(`toki.save.game.${this.o.gameId}`, String(t));
    } catch {
      /* storage blocked */
    }
  }

  private adoptAnon(): LocalRecord | null {
    const anon = readRecord(this.o.kv, "anon", this.o.gameId);
    if (!anon) return null;
    const rec = { save: anon.save, bases: [], dirty: true };
    this.setRec(rec);
    return rec;
  }

  private putConflictCopy(save: SaveData, bases: number[]) {
    this.o.cloud.put(this.o.gameId, save, bases, this.o.device).catch(() => {});
  }

  private async upload() {
    if (this.stopped || !this.o.userId || !this.cloud.known) return;
    if (this.uploading) {
      this.again = true;
      return;
    }
    const rec = this.rec();
    if (!rec?.dirty) return;
    // Nothing changed since the account save this one builds on (games often save the same
    // state again): no need to send it.
    const cloud = this.cloud.save;
    if (cloud && rec.bases.includes(cloud.t) && !this.lost && sameKeys(rec.save.keys, cloud.keys)) {
      this.setRec({ ...rec, dirty: false });
      return;
    }
    this.uploading = true;
    this.lastUpload = this.o.now();
    const sent = rec.save;
    try {
      const res = await this.o.cloud.put(this.o.gameId, sent, rec.bases, this.o.device);
      const now = this.rec() ?? rec;
      if (res.ok) {
        this.cloud = { known: true, save: sent };
        this.setRec({ save: now.save, bases: [sent.t], dirty: now.save.t !== sent.t });
        this.setConflict(false);
      } else {
        this.cloud = { known: true, save: res.current };
        this.setConflict(true);
      }
    } catch {
      // Unknown whether it arrived: it may be the account save now, so later saves may build on it.
      const now = this.rec() ?? rec;
      this.setRec({ ...now, bases: [...now.bases.filter((b) => b !== sent.t), sent.t].slice(-MAX_BASES) });
      this.later(() => this.upload(), 5000);
    } finally {
      this.uploading = false;
    }
    if (this.again) {
      this.again = false;
      this.upload();
    }
  }
}

// The real account storage (Supabase) and this browser's storage.
export const supabaseCloud: Cloud = {
  async read(gameId) {
    const { data, error } = await supabase
      .from("game_saves")
      .select("data")
      .eq("game_id", gameId)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw error;
    return data ? asSave(data.data) : null;
  },
  async put(gameId, save, bases, device) {
    const { data, error } = await supabase.rpc("put_game_save", { p_game: gameId, p_data: save, p_bases: bases, p_device: device });
    if (error) throw error;
    const r = data as { ok: boolean; current?: unknown };
    return { ok: r.ok === true, current: asSave(r.current) };
  },
};

export const browserStorage: KeyValue = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => localStorage.setItem(k, v),
};

// Logging out stops all account traffic first, so nothing is uploaded on the way out.
const live = new Set<SaveSync>();
export function stopAccountSaves() {
  live.forEach((s) => s.stop());
  live.clear();
}

export type SaveStatus = "none" | "device" | "account";

/**
 * Answers save requests from the game in the frame. Only messages from that frame and the
 * game's own site count. Returns where saves currently go, and whether the account has newer
 * progress from another device than what the game shows.
 */
export function useSaveBridge(
  frame: RefObject<HTMLIFrameElement>,
  gameId: string | undefined,
  playUrl: string | undefined,
  userId: string | undefined,
): { status: SaveStatus; conflict: boolean; lost: boolean } {
  const [active, setActive] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [lost, setLost] = useState(false);
  const sync = useRef<SaveSync | null>(null);

  useEffect(() => setActive(false), [gameId]);

  useEffect(() => {
    setConflict(false);
    setLost(false);
    if (!gameId || !playUrl) return;
    let origin: string;
    try {
      origin = new URL(playUrl).origin;
    } catch {
      return;
    }
    const s = new SaveSync({
      gameId,
      userId,
      cloud: supabaseCloud,
      kv: browserStorage,
      device: visitorId(),
      answer: (data) => frame.current?.contentWindow?.postMessage({ toki: 1, type: "save", data }, origin),
      onConflict: setConflict,
      onLost: setLost,
    });
    sync.current = s;
    if (userId) live.add(s);

    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1) return;
      setActive(true);
      if (m.type === "hello") s.hello();
      else if (m.type === "store") {
        const save = asSave(m.data);
        if (!save) return;
        s.store(save);
        // A save made while the app is closing goes up right away.
        if (document.hidden) s.flush();
      }
    };
    const onHide = () => document.visibilityState === "hidden" && s.flush();
    const onPageHide = () => s.flush();
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      s.flush(); // does nothing after logout: stopAccountSaves already stopped it
      s.stop();
      live.delete(s);
      if (sync.current === s) sync.current = null;
    };
  }, [frame, gameId, playUrl, userId]);

  return { status: !active ? "none" : userId ? "account" : "device", conflict, lost };
}
