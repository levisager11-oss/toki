// The server sends cross-origin isolation headers only on pages of games that need them.
// Headers belong to the page that was loaded, so moving between pages inside the app keeps the
// old ones. When a page needs other headers than it got, load it again as a new page.
const TRIED = "toki.isolationReload";
const UNSUPPORTED = "toki.isolationUnsupported";

/** Whether this page runs with cross-origin isolation. */
export const pageIsolated = () => window.crossOriginIsolated === true;

/** Makes the page match: isolated or not. Loads the address again at most once per page. */
export function matchIsolation(wanted: boolean) {
  try {
    if (pageIsolated() === wanted) {
      sessionStorage.removeItem(TRIED);
      return;
    }
    if (sessionStorage.getItem(UNSUPPORTED)) return;
    if (sessionStorage.getItem(TRIED) === location.pathname) {
      // Loading again didn't help (e.g. a browser without "credentialless"): don't keep trying.
      sessionStorage.setItem(UNSUPPORTED, "1");
      return;
    }
    sessionStorage.setItem(TRIED, location.pathname);
  } catch {
    return; // without session storage we can't tell whether we tried already
  }
  location.reload();
}
