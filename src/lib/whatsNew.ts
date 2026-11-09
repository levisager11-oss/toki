// A dot next to "What's new" when Toki has an update this browser hasn't seen yet.
// One tiny request per tab (the date of the newest Toki update), nothing for games.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const SEEN_KEY = "toki.seenUpdate"; // localStorage: newest update this browser has seen
const LATEST_KEY = "toki.latestUpdate"; // sessionStorage: newest update, asked once per tab

const store = (s: () => Storage) => ({
  get: (k: string) => {
    try {
      return s().getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      s().setItem(k, v);
    } catch {
      /* only a convenience */
    }
  },
});
const local = store(() => localStorage);
const session = store(() => sessionStorage);

const listeners = new Set<() => void>();
let asking: Promise<string | null> | null = null;

function latest(): Promise<string | null> {
  const known = session.get(LATEST_KEY);
  if (known) return Promise.resolve(known);
  asking ??= Promise.resolve(
    supabase.from("game_releases").select("published_at").is("game_id", null).order("published_at", { ascending: false }).limit(1).maybeSingle(),
  ).then(({ data }) => {
    const at = (data as { published_at: string } | null)?.published_at ?? null;
    if (at) session.set(LATEST_KEY, at);
    return at;
  }, () => null);
  return asking;
}

/** Is there an update newer than what this browser has seen? A first visit counts as seen. */
export function isUnseen(latestAt: string | null, seenAt: string | null): boolean {
  if (!latestAt || !seenAt) return false;
  return Date.parse(latestAt) > Date.parse(seenAt);
}

export function useNewUpdate(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      latest().then((at) => {
        if (!alive || !at) return;
        // First visit: nothing is "new" yet.
        if (!local.get(SEEN_KEY)) local.set(SEEN_KEY, at);
        setOn(isUnseen(at, local.get(SEEN_KEY)));
      });
    check();
    listeners.add(check);
    return () => {
      alive = false;
      listeners.delete(check);
    };
  }, []);
  return on;
}

/** The updates page was opened: everything up to this update is seen. */
export function markUpdatesSeen(at: string) {
  const seen = local.get(SEEN_KEY);
  if (seen && Date.parse(seen) >= Date.parse(at)) return;
  local.set(SEEN_KEY, at);
  if (Date.parse(at) > Date.parse(session.get(LATEST_KEY) ?? "0")) session.set(LATEST_KEY, at);
  listeners.forEach((l) => l());
}
