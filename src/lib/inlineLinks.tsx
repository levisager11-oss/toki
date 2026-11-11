import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/** A text with "[text](/path)" links inside Toki, as text and links. */
export function inlineLinks(text: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\(\/[^)]*\))/).map((part, i) => {
    const m = /^\[([^\]]+)\]\((\/[^)]*)\)$/.exec(part);
    return m ? <Link key={i} to={m[2]}>{m[1]}</Link> : <Fragment key={i}>{part}</Fragment>;
  });
}
