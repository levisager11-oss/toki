import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { IDEA_LIMITS, IdeaError, proposeIdea, useIdeaBanner, type GameIdea, type IdeaStatus } from "../lib/ideas";
import { canCreate } from "../lib/types";
import { useDraft } from "../lib/useDraft";
import { ChatIcon } from "./icons";

// The same looks as feedback: open is quiet, claimed stands out, done is green.
const STATUS_CLASS: Record<IdeaStatus, string> = { open: "st-open", claimed: "st-in_progress", done: "st-done" };

export function IdeaStatusBadge({ status }: { status: IdeaStatus }) {
  const { t } = useI18n();
  return <span className={`st ${STATUS_CLASS[status]}`}>{t(`idea.status.${status}`)}</span>;
}

/** Who proposed it, when, who builds it and how many replies, under an idea's title. */
export function IdeaMeta({ idea }: { idea: GameIdea }) {
  const { t, lang } = useI18n();
  return (
    <span className="fb-meta">
      <IdeaStatusBadge status={idea.status} />
      <span>@{idea.author?.username ?? "?"}</span>
      <time dateTime={idea.created_at} title={new Date(idea.created_at).toLocaleString(lang === "de" ? "de-CH" : "en")}>{ago(idea.created_at, lang)}</time>
      {idea.reply_count > 0 && (
        <span className="fb-replies" title={t("fb.replies", { n: idea.reply_count })}>
          <ChatIcon /><span aria-hidden="true">{idea.reply_count}</span><span className="sr-only">{t("fb.replies", { n: idea.reply_count })}</span>
        </span>
      )}
      {idea.status === "claimed" && idea.claimer && <b>{t("idea.builtBy", { who: `@${idea.claimer.username}` })}</b>}
      {idea.status === "done" && idea.game && <Link to={`/game/${idea.game.slug}`} className="fb-fixed">{idea.game.title}</Link>}
    </span>
  );
}

/** The form to propose a game. What is typed is kept while moving around Toki. */
export function IdeaForm({ onDone, onCancel }: { onDone: (idea: GameIdea) => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useDraft("idea.title");
  const [body, setBody] = useDraft("idea.body");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) return setErr(t("idea.err.short"));
    setBusy(true);
    setErr("");
    try {
      const idea = await proposeIdea(title, body);
      setTitle("");
      setBody("");
      onDone(idea);
    } catch (e) {
      setErr(t(e instanceof IdeaError ? e.key : "error"));
    }
    setBusy(false);
  };

  return (
    <form className="form fb-form idea-form" onSubmit={submit}>
      <label htmlFor="idea-title">{t("idea.form.title")}</label>
      <input id="idea-title" required minLength={3} maxLength={IDEA_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("idea.form.titleHint")} />
      <label htmlFor="idea-body">{t("idea.form.body")}</label>
      <textarea id="idea-body" rows={4} maxLength={IDEA_LIMITS.body} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("idea.form.bodyHint")} />
      <small>{t("idea.form.who")}</small>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("idea.form.send")}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t("form.cancel")}</button>}
      </div>
    </form>
  );
}

/** "Missing a game you want?" on the home page. Admins can hide it for everyone. */
export function IdeaBanner() {
  const { t } = useI18n();
  const { session, profile } = useAuth();
  const shown = useIdeaBanner();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<GameIdea | null>(null);
  if (!shown) return null;

  return (
    <section className="idea-box" aria-labelledby="idea-box-h">
      <div className="idea-box-head">
        <div className="idea-box-txt">
          <h2 id="idea-box-h">{t("idea.box.title")}</h2>
          <p>{t("idea.box.text")}</p>
        </div>
        {!open && (
          <div className="actions">
            {session ? (
              <>
                <button type="button" className="btn primary" onClick={() => { setSent(null); setOpen(true); }}>{t(sent ? "idea.box.another" : "idea.propose")}</button>
                <Link to="/ideas" className="linkish">{t(canCreate(profile) ? "idea.box.all" : "idea.box.mine")}</Link>
              </>
            ) : (
              <Link to={`/login?next=${encodeURIComponent("/ideas?new=1")}`} className="btn primary">{t("idea.box.login")}</Link>
            )}
          </div>
        )}
      </div>
      {sent && !open && (
        <p className="check good" role="status">
          {t("idea.sent")} <Link to={`/ideas/${sent.id}`}>{t("idea.sentLink")}</Link>
        </p>
      )}
      {open && session && <IdeaForm onCancel={() => setOpen(false)} onDone={(idea) => { setSent(idea); setOpen(false); }} />}
    </section>
  );
}
