import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { inlineLinks as inline } from "../lib/inlineLinks";
import { useTitle } from "../lib/useTitle";
import { CONTACT_EMAIL } from "../lib/site";

// The terms of service, the privacy policy and the legal notice. Their texts are in
// src/lib/texts/legal*.ts: "## " starts a section, lines starting with "- " become a list,
// [text](/path) is a link inside Toki, and {email} is Toki's contact address.

/** Text with the contact address as a link that opens the mail app. */
function withEmail(text: string) {
  const parts = text.split(CONTACT_EMAIL);
  const mail = "mailto:" + CONTACT_EMAIL;
  return parts.flatMap((part, i) => {
    const text = <span key={i * 2}>{inline(part)}</span>;
    return i ? [<a key={i * 2 - 1} href={mail}>{CONTACT_EMAIL}</a>, text] : [text];
  });
}

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.startsWith("## ")) return <h2 key={i}>{b.slice(3)}</h2>;
        const lines = b.split("\n");
        if (lines.every((l) => l.startsWith("- ")))
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{withEmail(l.slice(2))}</li>)}</ul>;
        return <p key={i}>{withEmail(b)}</p>;
      })}
    </>
  );
}

const PAGES = ["terms", "privacy", "imprint"] as const;

export function Legal({ page }: { page: (typeof PAGES)[number] }) {
  const { t } = useI18n();
  const title = t(`legal.${page}.title`);
  useTitle(title);
  return (
    <article className="legal">
      <h1 className="h">{title}</h1>
      <p className="lead">{t(`legal.${page}.lead`)}</p>
      <p className="hint">{t("legal.updated")}</p>
      <Body text={t(`legal.${page}.body`, { email: CONTACT_EMAIL })} />
      <p className="legal-more">
        {PAGES.filter((other) => other !== page).map((other) => <Link key={other} to={`/${other}`}>{t(`legal.${other}.title`)}</Link>)}
      </p>
    </article>
  );
}
