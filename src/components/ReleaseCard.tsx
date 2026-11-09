import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { noteBlocks, type Release } from "../lib/releases";
import { KindTag } from "./FeedbackBits";

/** Release notes as paragraphs and lists. Plain text only. */
export function Notes({ notes, className = "" }: { notes: string; className?: string }) {
  const blocks = noteBlocks(notes);
  if (!blocks.length) return null;
  return (
    <div className={`rel-notes ${className}`}>
      {blocks.map((b, i) =>
        b.type === "p" ? <p key={i}>{b.text}</p> : <ul key={i}>{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>,
      )}
    </div>
  );
}

export const releaseDate = (iso: string, lang: "en" | "de") =>
  new Date(iso).toLocaleDateString(lang === "de" ? "de-CH" : "en", { dateStyle: "medium" });

export function ReleaseCard({ release, highlight, actions }: { release: Release; highlight?: boolean; actions?: ReactNode }) {
  const { t, lang } = useI18n();
  return (
    <article id={`r-${release.id}`} className={`rel ${release.small ? "small" : ""} ${highlight ? "hl" : ""}`}>
      <header className="rel-head">
        <span className="ver">{release.version}</span>
        {release.small && <span className="rel-tag">{t("rel.small")}</span>}
        <time dateTime={release.published_at}>{releaseDate(release.published_at, lang)}</time>
      </header>
      {release.title && <h2>{release.title}</h2>}
      <Notes notes={release.notes} />
      {release.fixed.length > 0 && (
        <div className="rel-fixed">
          <h3 className="label">{t("rel.fromFeedback")}</h3>
          <ul>
            {release.fixed.map((f) => (
              <li key={f.id}><KindTag kind={f.kind} /> <Link to={`/feedback/${f.id}`}>{f.title}</Link></li>
            ))}
          </ul>
        </div>
      )}
      {actions}
    </article>
  );
}
