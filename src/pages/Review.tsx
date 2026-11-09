import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { invalidateGames } from "../lib/useGames";
import { REVIEW_CHANGED, reviewGame, reviewQueue, setTrusted, trustedCreators, type Submission } from "../lib/review";
import { Cover } from "../components/Cover";
import { LinkCheck } from "../components/LinkCheck";


/** Admins: approve or decline new games and new game links (/review). */
export function Review() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<Submission[] | null>(null);
  const [trusted, setTrustedList] = useState<{ id: string; username: string }[] | null>(null);
  const [error, setError] = useState(false);
  const [done, setDone] = useState("");

  const loadTrusted = () => trustedCreators().then(setTrustedList).catch(() => setTrustedList([]));
  useEffect(() => {
    reviewQueue().then(setQueue).catch(() => setError(true));
    loadTrusted();
  }, []);

  const finished = (s: Submission, approved: boolean) => {
    setQueue((q) => q?.filter((x) => x.id !== s.id) ?? null);
    setDone(t(approved ? "review.approved" : "review.declined", { title: s.title }));
    invalidateGames();
    window.dispatchEvent(new Event(REVIEW_CHANGED));
  };
  const trust = async (userId: string, on: boolean, name?: string) => {
    try {
      await setTrusted(userId, on);
      setQueue((q) => q?.map((x) => (x.created_by === userId && x.author ? { ...x, author: { ...x.author, role: on ? "creator" : "player" } } : x)) ?? null);
      if (on && name) setDone(t("review.trustedNow", { name }));
      loadTrusted();
    } catch {
      setError(true);
    }
  };

  if (error) return <p className="msg">{t("error")}</p>;
  return (
    <section className="fb-board review">
      <h1 className="h">{t("review.title")}</h1>
      <p className="lead">{t("review.lead")}</p>
      {done && <p className="check good" role="status">{done}</p>}

      {!queue ? (
        <p className="msg" aria-busy="true">{t("loading")}</p>
      ) : queue.length === 0 ? (
        <p className="msg fb-empty">{t("review.empty")}</p>
      ) : (
        <div className="rv-list">
          {queue.map((s) => <SubmissionCard key={s.id} s={s} onDone={(ok) => finished(s, ok)} onTrust={() => s.created_by && trust(s.created_by, true, s.author?.username)} />)}
        </div>
      )}

      <section className="rv-trusted" aria-labelledby="rv-trusted-h">
        <h2 id="rv-trusted-h">{t("review.trusted")}</h2>
        <p className="hint">{t("review.trustHelp")}</p>
        {trusted && trusted.length === 0 && <p className="hint">{t("review.noTrusted")}</p>}
        {trusted && trusted.length > 0 && (
          <ul>
            {trusted.map((c) => (
              <li key={c.id}>
                <b>@{c.username}</b>
                <button type="button" className="btn ghost-danger" onClick={() => trust(c.id, false)}>{t("review.untrust")}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function SubmissionCard({ s, onDone, onTrust }: { s: Submission; onDone: (approved: boolean) => void; onTrust: () => void }) {
  const { t, lang } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const newLink = s.status === "approved" && !!s.pending_play_url;
  const url = s.pending_play_url ?? s.play_url;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(false);
    try {
      await reviewGame(s.id, approve, note);
      onDone(approve);
    } catch {
      setErr(true);
      setBusy(false);
    }
  };

  return (
    <article className="rv">
      <div className="rv-head">
        <Cover slug={s.slug} cover={s.cover} image={s.thumbnail_url} />
        <div className="rv-info">
          <span className={`st ${newLink ? "st-open" : "st-in_progress"}`}>{t(newLink ? "review.newLink" : "review.newGame")}</span>
          <Link to={`/game/${s.slug}`} className="fb-title">{s.title}</Link>
          <span className="sub">
            {t("review.by", { name: s.author?.username ?? "?" })} · {t(`cat.${s.category}`)} · {t("review.submitted", { when: ago(s.submitted_at, lang) })}
            {s.needs_isolation ? ` · ${t("review.isolation")}` : ""}
          </span>
        </div>
      </div>

      <dl className="rv-links">
        {newLink && (
          <>
            <dt>{t("review.liveLink")}</dt>
            <dd className="url">{s.play_url}</dd>
          </>
        )}
        <dt>{newLink ? t("review.waitingLink") : t("form.url")}</dt>
        <dd className="url"><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></dd>
      </dl>
      <LinkCheck url={url} isolation={s.needs_isolation === true} />
      <div className="actions">
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn">{t("review.open")} ↗</a>
        <Link to={`/game/${s.slug}`} className="btn">{t("review.page")}</Link>
        {s.author?.role === "player" && <button type="button" className="linkish" onClick={onTrust}>{t("review.trust", { name: s.author.username })}</button>}
      </div>

      <div className="form rv-decide">
        <label htmlFor={`note-${s.id}`}>{t("review.note")}</label>
        <textarea id={`note-${s.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("review.notePlaceholder")} />
        {err && <p className="error" role="alert">{t("error")}</p>}
        <div className="actions fb-form-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => decide(true)}>{t("review.approve")}</button>
          <button type="button" className="btn ghost-danger" disabled={busy} onClick={() => decide(false)}>{t("review.decline")}</button>
        </div>
      </div>
    </article>
  );
}
