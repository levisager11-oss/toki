import { Fragment } from "react";

// http(s) addresses, up to the next space. Punctuation at the very end (like a full stop) isn't part of it.
const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING = /[.,;:!?)\]}'"»“”]+$/;

export type Part = { text: string; href?: string };

/** Splits text into plain parts and web addresses. */
export function splitLinks(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(TRAILING)?.[0] ?? "";
    // Keep a closing bracket that belongs to the address, e.g. a Wikipedia link with (…) in it.
    const keep = trail.startsWith(")") && url.slice(0, -trail.length).includes("(") ? 1 : 0;
    url = url.slice(0, url.length - trail.length + keep);
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Text in which web addresses can be clicked (they open in a new tab). */
export function Linkify({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="auto-link">{p.text}</a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
