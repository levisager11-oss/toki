import { useEffect, useState } from "react";

const PREFIX = "toki.draft.";

const read = (key: string) => {
  try {
    return sessionStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
};

/**
 * Text that isn't sent yet, kept in this tab (sessionStorage), so going to another page or
 * chat and back doesn't lose it. Setting it to "" (e.g. after sending) forgets it.
 */
export function useDraft(key: string): [string, (v: string) => void] {
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  // Another chat or post: show its own draft.
  useEffect(() => {
    if (state.key !== key) setState({ key, value: read(key) });
  }, [key, state.key]);
  const set = (v: string) => {
    setState({ key, value: v });
    try {
      if (v) sessionStorage.setItem(PREFIX + key, v);
      else sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* only a convenience */
    }
  };
  return [state.key === key ? state.value : read(key), set];
}
