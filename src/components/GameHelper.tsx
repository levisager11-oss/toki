import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { askHelper, assistError, type HelpTurn } from "../lib/assist";
import { browserStorage, readRecord } from "../lib/saves";
import { saveSummary } from "../lib/saveSummary";
import { AiText } from "./AiBits";

const MAX_TURNS = 20;
const key = (gameId: string) => `toki.helper.${gameId}`;

function load(gameId: string): HelpTurn[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(key(gameId)) ?? "[]");
    return Array.isArray(v) ? v.slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

/** "Ask AI": a small chat under the game for players who are stuck, or have a question about Toki. */
export function GameHelper({ game, onClose }: { game: { id: string; title: string; slug: string }; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  // Kept in this tab only, so a reload doesn't lose the conversation.
  const [turns, setTurns] = useState<HelpTurn[]>(() => load(game.id));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  // The player's progress as the game last saved it on this device, so hints fit where they are.
  const progress = () => {
    const rec = session ? readRecord(browserStorage, session.user.id, game.id) : null;
    const save = rec ? saveSummary(rec.save.keys) : "";
    return save ? { save, saved_at: rec!.save.t } : undefined;
  };
  const [hasSave] = useState(() => !!progress());

  useEffect(() => {
    try {
      sessionStorage.setItem(key(game.id), JSON.stringify(turns.slice(-MAX_TURNS)));
    } catch {
      /* only a convenience */
    }
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [turns, game.id]);

  const send = async (e?: FormEvent, question = text) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    const next: HelpTurn[] = [...turns, { role: "user", content: q.slice(0, 1000) }];
    setTurns(next);
    setText("");
    setBusy(true);
    setErr("");
    try {
      const answer = await askHelper(game.id, next, lang, progress());
      setTurns([...next, { role: "assistant", content: answer }]);
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
      // Give the question back, so it can be sent again.
      setTurns(turns);
      setText(q);
    }
    setBusy(false);
  };

  const starters = [t("helper.q.stuck"), ...(hasSave ? [t("helper.q.next")] : []), t("helper.q.controls"), t("helper.q.saves")];

  return (
    <section className="ai-box helper" aria-labelledby="helper-h">
      <div className="ai-box-head">
        <b id="helper-h">{t("helper.title", { title: game.title })}</b>
        <span className="actions">
          {turns.length > 0 && <button type="button" className="linkish" onClick={() => setTurns([])}>{t("helper.new")}</button>}
          <button type="button" className="linkish" onClick={onClose}>{t("assist.close")}</button>
        </span>
      </div>
      {!session ? (
        <p>
          {t("helper.login")} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link>
        </p>
      ) : (
        <>
          <div className="helper-list" ref={list} aria-live="polite">
            {turns.length === 0 && (
              <>
                <p className="hint">{t("helper.lead")}{hasSave && ` ${t("helper.seesSave")}`}</p>
                <div className="chips helper-starters">
                  {starters.map((s) => <button key={s} type="button" onClick={() => send(undefined, s)} disabled={busy}>{s}</button>)}
                </div>
              </>
            )}
            {turns.map((m, i) => (
              <div key={i} className={`helper-msg ${m.role === "user" ? "mine" : ""}`}>
                {m.role === "user" ? <p>{m.content}</p> : <AiText text={m.content} />}
              </div>
            ))}
            {busy && <p className="sub" aria-busy="true">{t("helper.thinking")}</p>}
          </div>
          {err && <p className="error" role="alert">{err}</p>}
          <form className="inline-form helper-form" onSubmit={send}>
            <label htmlFor="helper-input" className="sr-only">{t("helper.placeholder")}</label>
            <input id="helper-input" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={t("helper.placeholder")} autoComplete="off" />
            <button className="btn primary" disabled={busy || !text.trim()}>{t("helper.send")}</button>
          </form>
          <p className="sub ai-box-note">{t("helper.note", { slug: game.slug })}</p>
        </>
      )}
    </section>
  );
}
