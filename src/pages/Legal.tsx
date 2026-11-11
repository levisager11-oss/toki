import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { inlineLinks as inline } from "../lib/inlineLinks";
import { useTitle } from "../lib/useTitle";

// The terms of service and the privacy policy. Their texts are in i18n.tsx: "## " starts a
// section, lines starting with "- " become a list, and [text](/path) is a link inside Toki.

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.startsWith("## ")) return <h2 key={i}>{b.slice(3)}</h2>;
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- ")))
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
        return <p key={i}>{inline(b)}</p>;
      })}
    </>
  );
}

export function Legal({ page }: { page: "terms" | "privacy" }) {
  const { t } = useI18n();
  const title = t(`legal.${page}.title`);
  useTitle(title);
  return (
    <article className="legal">
      <h1 className="h">{title}</h1>
      <p className="lead">{t(`legal.${page}.lead`)}</p>
      <p className="hint">{t("legal.updated")}</p>
      <Body text={t(`legal.${page}.body`)} />
      <p>
        <Link to={page === "terms" ? "/privacy" : "/terms"}>{t(page === "terms" ? "legal.privacy.title" : "legal.terms.title")}</Link>
      </p>
    </article>
  );
}
