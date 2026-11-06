// Game saves. Games run on their own sites inside Toki's frame, and iPhones delete storage of
// sites shown inside other sites when the app closes. Games that include /toki-save.js send
// their saves here: Toki keeps them on this device and, for logged-in players, in the cloud.
import { useEffect, useRef, useState, type RefObject } from "react";
import { supabase } from "./supabase";

export interface SaveData {
  keys: Record<string, string>;
  /** When the game made this save (ms since 1970). The newest save wins. */
  t: number;
}

const MAX_BYTES = 1_000_000;
const CLOUD_WAIT_MS = 2000;
const CLOUD_TIMEOUT_MS = 5000;

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

function readLocal(who: string, gameId: string): SaveData | null {
  try {
    return asSave(JSON.parse(localStorage.getItem(localKey(who, gameId)) ?? "null"));
  } catch {
    return null;
  }
}
function writeLocal(who: string, gameId: string, save: SaveData) {
  try {
    localStorage.setItem(localKey(who, gameId), JSON.stringify(save));
  } catch {
    /* storage full or blocked: the cloud copy still works for logged-in players */
  }
}

async function readCloud(gameId: string): Promise<SaveData | null> {
  const query = supabase.from("game_saves").select("data").eq("game_id", gameId).maybeSingle();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), CLOUD_TIMEOUT_MS));
  const res = await Promise.race([query, timeout]);
  return res && !res.error ? asSave(res.data?.data) : null;
}
async function writeCloud(userId: string, gameId: string, save: SaveData) {
  const { error } = await supabase
    .from("game_saves")
    .upsert({ user_id: userId, game_id: gameId, data: save, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/** The newest save for a game: this device, the account, or (first time logged in) this device before logging in. */
export async function loadSave(gameId: string, userId: string | undefined): Promise<SaveData | null> {
  if (!userId) return readLocal("anon", gameId);
  const [cloud, mine] = [await readCloud(gameId), readLocal(userId, gameId)];
  const best = newest(cloud, mine, cloud || mine ? null : readLocal("anon", gameId));
  if (best && best !== cloud) writeCloud(userId, gameId, best).catch(() => {});
  if (best) writeLocal(userId, gameId, best);
  return best;
}

export type SaveStatus = "none" | "device" | "account";

/**
 * Answers save requests from the game in the frame. Only messages from that frame and the
 * game's own site count. Returns where saves currently go.
 */
export function useSaveBridge(frame: RefObject<HTMLIFrameElement>, gameId: string | undefined, playUrl: string | undefined, userId: string | undefined): SaveStatus {
  const [active, setActive] = useState(false);
  const pending = useRef<SaveData | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => setActive(false), [gameId]);

  useEffect(() => {
    if (!gameId || !playUrl) return;
    let origin: string;
    try {
      origin = new URL(playUrl).origin;
    } catch {
      return;
    }
    const who = userId ?? "anon";

    const flushCloud = () => {
      clearTimeout(timer.current);
      const save = pending.current;
      pending.current = null;
      if (save && userId) writeCloud(userId, gameId, save).catch(() => {
        pending.current ??= save; // try again with the next save
      });
    };

    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1) return;
      setActive(true);
      if (m.type === "hello") {
        loadSave(gameId, userId).then((data) => win.postMessage({ toki: 1, type: "save", data }, origin));
      } else if (m.type === "store") {
        const save = asSave(m.data);
        if (!save) return;
        writeLocal(who, gameId, save);
        if (userId) {
          pending.current = save;
          clearTimeout(timer.current);
          timer.current = setTimeout(flushCloud, CLOUD_WAIT_MS);
        }
      }
    };

    const onHide = () => document.visibilityState === "hidden" && flushCloud();
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushCloud);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushCloud);
      flushCloud();
    };
  }, [frame, gameId, playUrl, userId]);

  return !active ? "none" : userId ? "account" : "device";
}
