// After a new version of Toki goes live, a tab that is still open asks for page files of the old
// version, which no longer exist. Loading the page again fetches the new version.

const KEY = "toki.reloadedAt";

/** Reloads the page, but not twice within a minute (so a file that is really missing can't loop). */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** A page file that couldn't be loaded (e.g. from an older version of Toki). */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

/** Loads a page on demand; if its file is gone because Toki was updated, loads Toki again. */
export function loadPage<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((e) => {
      if (isChunkError(e) && reloadOnce()) return new Promise<T>(() => {}); // the page reloads
      throw e;
    });
}
