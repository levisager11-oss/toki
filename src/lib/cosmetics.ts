// Toki 2.0: levels, Toki Tokens, cosmetics, the shop and trades. The rules live in the database
// (supabase/migrations/20261212090000_toki_tokens.sql); this file loads what the app shows:
// * the catalog of cosmetics (small, loaded once per visit),
// * the "look" of players (level, frame, name color, title, theme), asked for in batches: every
//   avatar and name on a page asks, and one request brings them all,
// * the logged-in player's own level, XP and tokens.
import { useEffect, useState, useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import { limitErrorKey } from "./limitValues";
import { termsApply } from "./terms";
import { EARN } from "./progress";

export type CosmeticKind = "frame" | "color" | "title" | "theme" | "stickers";
export type WearKind = Exclude<CosmeticKind, "stickers">;
export const KINDS: CosmeticKind[] = ["frame", "color", "title", "theme", "stickers"];
export const FRAME_STYLES = ["ring", "double", "dashed", "pixel", "glow", "spin", "rainbow"] as const;
export type FrameStyle = (typeof FRAME_STYLES)[number];
export const THEME_PATTERNS = ["plain", "dots", "grid", "stripes", "stars", "waves"] as const;
/** The looks a game's own cosmetics may have (the rest are the shop's; the database checks it too). */
export const GAME_FRAME_STYLES = ["ring", "double", "dashed", "pixel"] as const;
export const GAME_THEME_PATTERNS = ["plain", "dots", "grid", "stripes"] as const;
export type ThemePattern = (typeof THEME_PATTERNS)[number];

export interface Style {
  style?: FrameStyle;
  /** "#rrggbb" */
  a?: string;
  b?: string;
  pattern?: ThemePattern;
  /** stickers: the pack (src/lib/stickers.ts) */
  pack?: string;
}

export interface Cosmetic {
  id: string;
  kind: CosmeticKind;
  name: string;
  name_de: string | null;
  /** tokens in the shop; null: not sold */
  price: number | null;
  min_level: number;
  style: Style;
  /** a game's own cosmetic: the game and the achievement that gives it */
  game_id: string | null;
  achievement: string | null;
  position: number;
  active: boolean;
  /** a uuid made from the id, to report a game's cosmetic */
  ref?: string;
}

export const cosmeticName = (c: Pick<Cosmetic, "name" | "name_de">, lang: string) => (lang === "de" && c.name_de) || c.name;

/** The column on profiles that holds what a player wears of a kind. */
export const WEAR_COLUMN: Record<WearKind, "frame" | "name_color" | "title" | "theme"> = {
  frame: "frame", color: "name_color", title: "title", theme: "theme",
};

/** An i18n key for what went wrong, from the server's error. */
export function shopErrorKey(error: unknown): string {
  const m = (error as { message?: string } | null)?.message ?? String(error ?? "");
  for (const k of ["not_enough_tokens", "owned", "level", "not_owned", "already_owned", "not_friends", "not_yet", "too_many_open", "closed", "banned", "too_many_cosmetics", "bad_cosmetics"]) {
    if (m.includes(k)) return `shop.err.${k}`;
  }
  if (m.includes("rate_limited")) return limitErrorKey(m) ?? "soc.err.rateLimited";
  return "error";
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// ---------- the catalog ----------

let catalog: Promise<Map<string, Cosmetic>> | null = null;
let catalogNow: Map<string, Cosmetic> | null = null;
const catalogListeners = new Set<() => void>();

export function loadCatalog(force = false): Promise<Map<string, Cosmetic>> {
  if (!catalog || force) {
    catalog = (async () => {
      const { data, error } = await supabase.from("cosmetics").select("*").order("position").order("id");
      if (error) throw error;
      return new Map((data as Cosmetic[]).map((c) => [c.id, c]));
    })().then(
      (m) => {
        catalogNow = m;
        catalogListeners.forEach((l) => l());
        return m;
      },
      (e) => {
        catalog = null;
        throw e;
      },
    );
  }
  return catalog;
}

/** The catalog, or null while it loads. */
export function useCatalog(): Map<string, Cosmetic> | null {
  const now = useSyncExternalStore(
    (l) => {
      catalogListeners.add(l);
      return () => catalogListeners.delete(l);
    },
    () => catalogNow,
    () => null,
  );
  useEffect(() => {
    if (!catalogNow) loadCatalog().catch(() => {});
  }, []);
  return now;
}

// ---------- how players look ----------

export interface Look {
  id: string;
  level: number;
  xp: number;
  frame: string | null;
  name_color: string | null;
  title: string | null;
  theme: string | null;
}

const looks = new Map<string, Look | null>();
const asked = new Set<string>();
let batch: Set<string> | null = null;
let looksVersion = 0;
const lookListeners = new Set<() => void>();

function askLook(id: string) {
  if (asked.has(id)) return;
  asked.add(id);
  if (!batch) {
    batch = new Set();
    // Everything that asks while this page draws goes into one request.
    setTimeout(flushLooks, 30);
  }
  batch.add(id);
}

async function flushLooks() {
  const ids = [...(batch ?? [])];
  batch = null;
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    try {
      const rows = await rpc<Look[]>("player_looks", { p_ids: part });
      for (const id of part) looks.set(id, rows.find((r) => r.id === id) ?? null);
    } catch {
      // Tried again the next time it is asked for.
      for (const id of part) asked.delete(id);
    }
  }
  looksVersion++;
  lookListeners.forEach((l) => l());
}

/** How a player looks (undefined while it loads, or for no id). */
export function useLook(id: string | null | undefined): Look | undefined {
  useSyncExternalStore(
    (l) => {
      lookListeners.add(l);
      return () => lookListeners.delete(l);
    },
    () => looksVersion,
    () => 0,
  );
  useEffect(() => {
    if (id) askLook(id);
  }, [id]);
  return id ? looks.get(id) ?? undefined : undefined;
}

/** Asks again for a player's look, e.g. after they put something on. */
export function refreshLook(id: string) {
  asked.delete(id);
  askLook(id);
}

// ---------- the logged-in player ----------

export interface TokenChange {
  amount: number;
  reason: "level" | "achievement" | "daily" | "buy" | "trade" | "admin" | "start";
  data: { level?: number; cosmetic?: string; game?: string; streak?: number; with?: string };
  at: string;
}
export interface MyProgress {
  xp: number;
  level: number;
  tokens: number;
  xp_today: number;
  log: TokenChange[];
}

let mine: MyProgress | null = null;
let mineFor: string | null = null;
let mineAt = 0;
let mineLoading: { user: string; promise: Promise<void> } | null = null;
let mineSeq = 0;
const mineListeners = new Set<() => void>();
/** Fired with the new level when the player reaches one while Toki is open. */
export const LEVEL_UP = "toki:level-up";

/** Loads the logged-in player's progress again (at most every 20 seconds, unless forced). */
export function refreshProgress(userId: string | null | undefined, force = false): Promise<void> {
  if (!userId) {
    mineSeq++;
    mineLoading = null;
    mine = null;
    mineFor = null;
    mineListeners.forEach((l) => l());
    return Promise.resolve();
  }
  if (!force && mineFor === userId && Date.now() - mineAt < 20_000) return Promise.resolve();
  // A request for the same player that is already under way is shared, unless a fresh one is forced.
  if (!force && mineLoading && mineLoading.user === userId) return mineLoading.promise;
  // Otherwise a new request starts, and only the latest one may write its answer.
  const seq = ++mineSeq;
  const promise: Promise<void> = rpc<MyProgress | null>("my_progress")
    .then((p) => {
      if (seq !== mineSeq) return;
      const before = mineFor === userId ? mine : null;
      mine = p;
      mineFor = userId;
      mineAt = Date.now();
      if (before && p && p.level > before.level && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(LEVEL_UP, { detail: { level: p.level, tokens: EARN.levelTokens * (p.level - before.level) } }));
      }
      // The player's own look shows the new level too.
      refreshLook(userId);
      mineListeners.forEach((l) => l());
    })
    .catch(() => {})
    .finally(() => {
      if (mineLoading?.promise === promise) mineLoading = null;
    });
  mineLoading = { user: userId, promise };
  return promise;
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Something that can earn XP happened (a score, an achievement): asks again in a moment. */
export function progressMaybeChanged() {
  if (!mineFor) return;
  const id = mineFor;
  clearTimeout(soon);
  soon = setTimeout(() => void refreshProgress(id, true), 1500);
}

/** The logged-in player's level, XP and tokens (null while it loads or when logged out). */
export function useMyProgress(userId: string | null | undefined): MyProgress | null {
  const now = useSyncExternalStore(
    (l) => {
      mineListeners.add(l);
      return () => mineListeners.delete(l);
    },
    () => (mineFor === userId ? mine : null),
    () => null,
  );
  useEffect(() => {
    void refreshProgress(userId);
  }, [userId]);
  return now;
}

// ---------- the shop ----------

export const buyCosmetic = (id: string) => rpc<number>("buy_cosmetic", { p_id: id });
export const equipCosmetic = (kind: WearKind, id: string | null) => rpc<void>("equip_cosmetic", { p_kind: kind, p_id: id });

/** The ids of the cosmetics a player has, newest first. */
export async function collectionOf(userId: string): Promise<{ id: string; got_at: string; how: string }[]> {
  const { data, error } = await supabase.from("player_cosmetics").select("cosmetic_id, got_at, how").eq("user_id", userId).order("got_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as { cosmetic_id: string; got_at: string; how: string }[]).map((r) => ({ id: r.cosmetic_id, got_at: r.got_at, how: r.how }));
}

/** Hook: a player's collection (null while it loads); reload() after buying or trading. */
export function useCollection(userId: string | null | undefined) {
  const [ids, setIds] = useState<Set<string> | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    setIds(null);
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    collectionOf(userId).then((rows) => alive && setIds(new Set(rows.map((r) => r.id))), () => alive && setIds(new Set()));
    return () => {
      alive = false;
    };
  }, [userId, n]);
  return { ids, reload: () => setN((x) => x + 1) };
}

export const adminSetCosmetic = (id: string, price: number | null, active: boolean) =>
  rpc<void>("admin_set_cosmetic", { p_id: id, p_price: price, p_active: active });
export const adminAdjustTokens = (userId: string, amount: number) => rpc<number>("admin_adjust_tokens", { p_user: userId, p_amount: amount });
export const adminTakeCosmetic = (userId: string, id: string) => rpc<void>("admin_take_cosmetic", { p_user: userId, p_id: id });
export const adminProgress = (userId: string) => rpc<{ tokens: number; log: TokenChange[] } | null>("admin_progress", { p_user: userId });

// ---------- a game's own cosmetics ----------

export interface GameCosmeticInput {
  id?: string;
  kind: WearKind;
  name: string;
  name_de?: string | null;
  style: Style;
  achievement: string;
}
export const setGameCosmetics = (gameId: string, list: GameCosmeticInput[]) =>
  rpc<Cosmetic[]>("set_game_cosmetics", { p_game: gameId, p_list: list }).then((r) => {
    void loadCatalog(true);
    return r;
  });

// ---------- top players ----------

export interface TopRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  avatar_seed: string | null;
  level: number;
  xp: number;
}
export interface TopWeekRow extends TopRow {
  /** XP earned since Monday 00:00 UTC */
  xp_week: number;
}
export const topPlayersWeek = (friends: boolean) => rpc<TopWeekRow[]>("top_players_week", { p_friends: friends, p_limit: 50 });
export const topPlayers = (friends: boolean) => rpc<TopRow[]>("top_players", { p_friends: friends, p_limit: 50 });

// ---------- trades ----------

/** Trading opens the day the terms about it apply (src/lib/terms.ts). */
export const tradingOpen = () => termsApply("tokens");

export interface Trade {
  id: string;
  /** the logged-in player offered it */
  mine: boolean;
  other_id: string;
  other_username: string;
  other_avatar_url: string | null;
  other_avatar_seed: string | null;
  give_tokens: number;
  give_items: string[];
  want_tokens: number;
  want_items: string[];
  status: "open" | "done" | "declined" | "cancelled" | "expired" | "failed";
  created_at: string;
  answered_at: string | null;
}
export const myTrades = () => rpc<Trade[]>("my_trades");
/** Nothing wanted (no tokens, no items) makes it a gift. replyTo: an offer received from this friend, declined by sending this one. */
export const offerTrade = (to: string, giveTokens: number, giveItems: string[], wantTokens: number, wantItems: string[], replyTo?: string) =>
  rpc<string>("offer_trade", { p_to: to, p_give_tokens: giveTokens, p_give_items: giveItems, p_want_tokens: wantTokens, p_want_items: wantItems, p_reply_to: replyTo ?? null });
export const answerTrade = (id: string, accept: boolean) => rpc<"done" | "declined" | "failed">("answer_trade", { p_id: id, p_accept: accept });
export const cancelTrade = (id: string) => rpc<void>("cancel_trade", { p_id: id });
