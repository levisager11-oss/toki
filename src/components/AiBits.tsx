import { Fragment, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { assistError, detectLang, translate, useAiFeature, type TranslateKind } from "../lib/assist";

/** A button that asks the AI for a summary and shows it (nothing when summaries are off). */
export function SummaryButton({ label, load }: { label: string; load: () => Promise<string> }) {
  const { t } = useI18n();
  const on = useAiFeature("summary");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!on) return null;
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      setText(await load());
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };
  return (
    <div className="ai-inline">
      <button type="button" className="linkish ai-link" onClick={run} disabled={busy}>
        {busy ? t("assist.summarizing") : label}
      </button>
      {err && <p className="error" role="alert">{err}</p>}
      {text !== null && (
        <AiBox title={label} onClose={() => setText(null)}>
          {text ? <AiText text={text} /> : <p className="hint">{t("assist.nothing")}</p>}
        </AiBox>
      )}
    </div>
  );
}

export interface Translation {
  /** whether to offer translating (logged in, AI on, and the text is in the other language) */
  offer: boolean;
  /** the translated texts while they're shown */
  texts: string[] | null;
  busy: boolean;
  error: string;
  toggle: () => void;
}

/** Translating a post, reply, chat message or game text into the page's language, on request. */
export function useTranslate(kind: TranslateKind, id: string | number, sample: string): Translation {
  const { lang, t } = useI18n();
  const { session } = useAuth();
  const on = useAiFeature("translate");
  const [texts, setTexts] = useState<string[] | null>(null);
  const [cache, setCache] = useState<{ lang: string; texts: string[] } | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Another post, reply, message or game in the same place (e.g. after following a link): start over.
  const key = `${kind}:${id}`;
  const current = useRef(key);
  current.current = key;
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setTexts(null);
    setCache(null);
    setShown(false);
    setError("");
  }
  const from = detectLang(sample);
  const offer = !!session && on && !!from && from !== lang;
  const toggle = () => {
    if (shown) return setShown(false);
    if (cache?.lang === lang) {
      setTexts(cache.texts);
      return setShown(true);
    }
    setBusy(true);
    setError("");
    translate(kind, id, lang)
      .then((out) => {
        // The page moved on to something else meanwhile.
        if (current.current !== key) return;
        setCache({ lang, texts: out });
        setTexts(out);
        setShown(true);
      })
      .catch((e) => setError(t(`assist.err.${assistError(e)}`)))
      .finally(() => setBusy(false));
  };
  return { offer, texts: shown ? texts : null, busy, error, toggle };
}

/** "Translate" / "Show original", with a note that the AI translated it. */
export function TranslateToggle({ tr }: { tr: Translation }) {
  const { t } = useI18n();
  if (!tr.offer) return null;
  return (
    <span className="ai-translate">
      <button type="button" className="linkish" onClick={tr.toggle} disabled={tr.busy} aria-pressed={!!tr.texts}>
        {tr.busy ? t("assist.translating") : tr.texts ? t("assist.original") : t("assist.translate")}
      </button>
      {tr.texts && <span className="sub"> · {t("assist.translatedNote")}</span>}
      {tr.error && <span className="error" role="alert"> {tr.error}</span>}
    </span>
  );
}

/** Text the AI wrote: lines ending with ":" are headings, lines starting with "- " a list. */
export function AiText({ text }: { text: string }) {
  const blocks: { head?: string; items: string[]; lines: string[] }[] = [];
  let cur: (typeof blocks)[number] = { items: [], lines: [] };
  const push = () => (cur.head || cur.items.length || cur.lines.length) && blocks.push(cur);
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\*\*/g, "");
    if (!line) continue;
    if (/^#+\s*/.test(line) || (/:$/.test(line) && !/^[-*•]/.test(line) && line.length <= 80)) {
      push();
      cur = { head: line.replace(/^#+\s*/, "").replace(/:$/, ""), items: [], lines: [] };
    } else if (/^([-*•]|\d+\.)\s+/.test(line)) cur.items.push(line.replace(/^([-*•]|\d+\.)\s+/, ""));
    else cur.lines.push(line);
  }
  push();
  return (
    <div className="ai-text">
      {blocks.map((b, i) => (
        <Fragment key={i}>
          {b.head && <h3 className="label">{b.head}</h3>}
          {b.lines.map((l, j) => <p key={j}>{l}</p>)}
          {b.items.length > 0 && <ul>{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>}
        </Fragment>
      ))}
    </div>
  );
}

/** A box with what the AI wrote, marked as such. */
export function AiBox({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  const { t } = useI18n();
  return (
    <section className="ai-box" aria-label={title}>
      <div className="ai-box-head">
        <b>{title}</b>
        {onClose && <button type="button" className="linkish" onClick={onClose}>{t("assist.close")}</button>}
      </div>
      {children}
      <p className="sub ai-box-note">{t("assist.aiNote")}</p>
    </section>
  );
}
