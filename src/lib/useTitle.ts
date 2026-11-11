import { useEffect } from "react";

// The tab title is "(unread) <page> · Toki". Pages set the page part, the layout the unread count.
// `page` is the whole title without the count, e.g. "Chat · Toki".
let page: string | null = null;
let unread = 0;
const apply = () => {
  const base = page ?? "Toki";
  document.title = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
};

/**
 * Sets the browser tab title to "<title> · Toki" while the page is open. Nothing (null/empty)
 * shows just "Toki". With `full`, the title is shown as it is (the home page's "Toki: …").
 */
export function useTitle(title: string | null | undefined, opts?: { full?: boolean }) {
  const full = opts?.full ?? false;
  useEffect(() => {
    page = title ? (full ? title : `${title} · Toki`) : null;
    apply();
    return () => {
      page = null;
      apply();
    };
  }, [title, full]);
}

/** Unread chats and notifications, shown in front of the tab title. */
export function setTitleCount(n: number) {
  if (n === unread) return;
  unread = n;
  apply();
}

/** For tests: sets both parts and returns the title. */
export const titleFor = (pageTitle: string | null, count: number, full = false) => {
  page = pageTitle ? (full ? pageTitle : `${pageTitle} · Toki`) : null;
  unread = count;
  apply();
  return document.title;
};
