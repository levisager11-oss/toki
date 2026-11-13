import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listOf, useI18n } from "../lib/i18n";
import { inlineLinks as inline } from "../lib/inlineLinks";
import { useTitle } from "../lib/useTitle";
import { CONTACT_EMAIL } from "../lib/site";
import { aiServiceName, ANTHROPIC_HOST, LEGAL_DATE, loadPolicyFacts, policyDate, type PolicyFacts } from "../lib/policy";

// The terms of service, the privacy policy and the legal notice. Their texts are in
// src/lib/texts/legal*.ts: "## " starts a section, lines starting with "- " become a list,
// [text](/path) is a link inside Toki, and {email} is Toki's contact address. What the privacy
// policy says about AI follows the settings: switching AI on or off on the AI page changes the
// page and its date right away (src/lib/policy.ts).

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
  const { t, lang } = useI18n();
  const title = t(`legal.${page}.title`);
  useTitle(title);
  // undefined: still loading. null: couldn't be loaded.
  const [facts, setFacts] = useState<PolicyFacts | null | undefined>(undefined);
  useEffect(() => {
    if (page !== "privacy") return;
    let alive = true;
    void loadPolicyFacts().then((f) => alive && setFacts(f));
    return () => {
      alive = false;
    };
  }, [page]);

  // The AI services in use, by name ("Anthropic (Anthropic PBC, USA)").
  const hosts = facts?.ai_hosts ?? [];
  const services = hosts.map((host) => aiServiceName(host) ?? t("legal.privacy.ai.host", { host }));
  const service = listOf(services, lang);
  const ai = !facts ? t("legal.privacy.ai.loading") : hosts.length ? t("legal.privacy.ai.on", { service }) : t("legal.privacy.ai.off");
  const vars = {
    email: CONTACT_EMAIL,
    ai,
    ai_training: hosts.length > 0 && hosts.every((h) => h === ANTHROPIC_HOST) ? t("legal.privacy.ai.training") : "",
    ai_line: services.map((s) => t("legal.privacy.ai.line", { service: s }) + "\n").join(""),
  };
  const day = new Date((page === "privacy" ? policyDate(facts ?? null) : LEGAL_DATE) + "T12:00:00");
  const date = new Intl.DateTimeFormat(lang === "de" ? "de-CH" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(day);
  return (
    <article className="legal">
      <h1 className="h">{title}</h1>
      <p className="lead">{t(`legal.${page}.lead`)}</p>
      <p className="hint">{t("legal.updated", { date })}</p>
      <Body text={t(`legal.${page}.body`, vars)} />
      <p className="legal-more">
        {PAGES.filter((other) => other !== page).map((other) => <Link key={other} to={`/${other}`}>{t(`legal.${other}.title`)}</Link>)}
      </p>
    </article>
  );
}
