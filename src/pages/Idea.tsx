import { useEffect, useState, type FormEvent } from "react";
import { ReportButton } from "../components/ReportButton";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import {
  addIdeaReply, claimIdea, deleteIdea, deleteIdeaReply, finishIdea, getIdea, IDEA_LIMITS, IdeaError, listIdeaReplies, releaseIdea,
  type GameIdea, type IdeaReply,
} from "../lib/ideas";
import { canCreate } from "../lib/types";
import { useGames } from "../lib/useGames";
import { useDraft } from "../lib/useDraft";
import { useTitle } from "../lib/useTitle";
import { Linkify } from "../components/Linkify";
import { IdeaMeta } from "../components/IdeaBits";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One game idea with its discussion (/ideas/:id): developers claim it here. */
export function Idea() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const { profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { games } = useGames();
  const [idea, setIdea] = useState<GameIdea | null | undefined>(undefined);
  const [replies, setReplies] = useState<IdeaReply[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  // Marking as done: which of the developer's games it became.
  const [finishing, setFinishing] = useState(false);
  const [gameId, setGameId] = useState("");
  const sent = (location.state as { sent?: boolean } | null)?.sent === true;
  const me = profile?.id;

  useEffect(() => {
    if (!UUID.test(id)) {
      setIdea(null);
      return;
    }
    let alive = true;
    setIdea(undefined);
    Promise.all([getIdea(id), listIdeaReplies(id)])
      .then(([i, r]) => {
        if (!alive) return;
        setIdea(i);
        setReplies(r);
      })
      .catch(() => alive && setIdea(null));
    return () => {
      alive = false;
    };
  }, [id, me]);

  useTitle(idea?.title);

  if (idea === undefined)
    return (
      <section className="fb-post skel" aria-busy="true" aria-label={t("loading")}>
        <span className="bar" style={{ width: "30%" }} />
        <span className="bar big" />
        <span className="bar" style={{ width: "80%" }} />
      </section>
    );
  if (idea === null)
    return (
      <div className="msg">
        <p>{t("idea.notFound")}</p>
        <Link to="/ideas" className="btn">{t("idea.title")}</Link>
      </div>
    );

  const dev = canCreate(profile);
  const admin = profile?.role === "admin";
  const isAuthor = me === idea.author_id;
  const isClaimer = !!me && me === idea.claimed_by;
  // The games the idea can be marked done with: the ones of the developer building it.
  const theirGames = (games ?? []).filter((g) => g.created_by === idea.claimed_by);

  const reload = () => getIdea(idea.id).then((i) => i && setIdea(i)).catch(() => {});
  /** true when it worked */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    let ok = true;
    try {
      await fn();
      await reload();
    } catch (e) {
      ok = false;
      setError(t(e instanceof IdeaError ? e.key : "error"));
      // Someone else was faster: show what it looks like now.
      if (e instanceof IdeaError && e.key === "idea.err.taken") await reload();
    }
    setBusy(false);
    return ok;
  };
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await deleteIdea(idea.id);
      navigate("/ideas", { replace: true });
    } catch {
      setError(t("error"));
      setBusy(false);
    }
  };
  const finish = (e: FormEvent) => {
    e.preventDefault();
    if (!gameId) return;
    run(() => finishIdea(idea.id, gameId)).then((ok) => ok && setFinishing(false));
  };

  return (
    <article className="fb-post idea-post">
      <Link to="/ideas" className="back">← {t(dev ? "idea.title" : "idea.mine")}</Link>
      {sent && <p className="check good" role="status">{t("idea.sent")}</p>}

      <header className="fb-head">
        <div className="fb-main">
          <h1>{idea.title}</h1>
          <IdeaMeta idea={idea} />
        </div>
      </header>
      {idea.body && <p className="fb-body"><Linkify text={idea.body} /></p>}

      <section className="fb-manage" aria-labelledby="idea-state-h">
        <h2 id="idea-state-h" className="label">{t("idea.state")}</h2>
        {idea.status === "open" && <p>{t(dev ? "idea.open.dev" : "idea.open.player")}</p>}
        {idea.status === "claimed" && (
          <p>{isClaimer ? t("idea.claimed.you") : t("idea.claimed.by", { who: idea.claimer ? `@${idea.claimer.username}` : "?" })}</p>
        )}
        {idea.status === "done" && (
          <p>
            {t("idea.done")}{" "}
            {idea.game && <Link to={`/game/${idea.game.slug}`}><b>{idea.game.title}</b></Link>}
          </p>
        )}

        {finishing ? (
          <form className="fb-manage-row" onSubmit={finish}>
            <label>
              <span className="label-text">{t("idea.pickGame")}</span>
              <select value={gameId} onChange={(e) => setGameId(e.target.value)} required>
                <option value="">{t("idea.pickGame.none")}</option>
                {theirGames.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </label>
            <button className="btn primary" disabled={busy || !gameId}>{t("idea.markDone")}</button>
            <button type="button" className="btn" onClick={() => setFinishing(false)} disabled={busy}>{t("form.cancel")}</button>
            {theirGames.length === 0 && <p className="hint">{t("idea.noGames")} <Link to="/add">{t("nav.addGame")}</Link></p>}
          </form>
        ) : (
          <div className="fb-manage-row">
            {idea.status === "open" && dev && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => claimIdea(idea.id))}>{t("idea.claim")}</button>
            )}
            {idea.status === "claimed" && (isClaimer || admin) && (
              confirmRelease ? (
                <>
                  <button type="button" className="btn danger" disabled={busy} onClick={() => run(() => releaseIdea(idea.id)).then(() => setConfirmRelease(false))}>{t(isClaimer ? "idea.releaseSure" : "idea.releaseAdminSure")}</button>
                  <button type="button" className="btn" onClick={() => setConfirmRelease(false)}>{t("form.cancel")}</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => { setGameId(""); setFinishing(true); }}>{t("idea.markDone")}</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRelease(true)}>{t(isClaimer ? "idea.release" : "idea.releaseAdmin")}</button>
                </>
              )
            )}
          </div>
        )}
        {idea.status === "open" && dev && <p className="hint">{t("idea.claimHint")}</p>}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {!isAuthor && <div className="report-line"><ReportButton key={idea.id} kind="idea" target={idea.id} /></div>}
      {/* Deleting takes two taps: the first asks "for good?". Kept apart from the buttons above. */}
      {((isAuthor && idea.status === "open") || admin) && (
        <p className="idea-tools">
          <button
            type="button"
            className={`linkish ${confirmDelete ? "danger-text" : ""}`}
            disabled={busy}
            onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
          >
            {t(confirmDelete ? "idea.deleteSure" : "idea.delete")}
          </button>
        </p>
      )}

      <Discussion idea={idea} replies={replies} setReplies={setReplies} onChanged={reload} />
    </article>
  );
}

function Discussion({ idea, replies, setReplies, onChanged }: {
  idea: GameIdea;
  replies: IdeaReply[];
  setReplies: (f: (r: IdeaReply[]) => IdeaReply[]) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [body, setBody] = useDraft(`idea-reply.${idea.id}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Deleting a reply takes two taps: the first asks "Sure?".
  const [deleting, setDeleting] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(t(e instanceof IdeaError ? e.key : "error"));
    }
    setBusy(false);
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    run(async () => {
      const r = await addIdeaReply(idea.id, body);
      setReplies((list) => [...list, r]);
      setBody("");
      onChanged();
    });
  };
  const remove = (id: string) =>
    run(async () => {
      await deleteIdeaReply(id);
      setReplies((list) => list.filter((x) => x.id !== id));
      onChanged();
    });

  const badge = (r: IdeaReply) => {
    if (r.author_id === idea.claimed_by) return t("idea.badge.builder");
    if (r.author_id === idea.author_id) return t("idea.badge.author");
    return canCreate(r.author) ? t("fb.byDev") : null;
  };

  return (
    <section className="fb-replies-list" aria-labelledby="idea-talk-h">
      <h2 id="idea-talk-h">{t("idea.talk")}</h2>
      <p className="hint">{t("idea.talk.who")}</p>
      {replies.length === 0 && <p className="hint">{t("idea.talk.none")}</p>}
      <ol>
        {replies.map((r) => (
          <li key={r.id} className={r.author_id === idea.claimed_by ? "official" : ""}>
            <div className="fb-reply-head">
              <b>@{r.author?.username ?? "?"}</b>
              {badge(r) && <span className="st st-planned">{badge(r)}</span>}
              <time className="sub" dateTime={r.created_at}>{ago(r.created_at, lang)}</time>
            </div>
            <p className="fb-body"><Linkify text={r.body} /></p>
            {(profile?.id === r.author_id || profile?.role === "admin") && (
              <div className="fb-reply-actions">
                <button
                  type="button"
                  className={`linkish ${deleting === r.id ? "danger-text" : ""}`}
                  disabled={busy}
                  onClick={() => (deleting === r.id ? (setDeleting(null), remove(r.id)) : setDeleting(r.id))}
                  onBlur={() => setDeleting((cur) => (cur === r.id ? null : cur))}
                >
                  {deleting === r.id ? t("chat.deleteSure") : t("fb.reply.delete")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {err && <p className="error" role="alert">{err}</p>}
      <form className="form fb-reply-form" onSubmit={send}>
        <label htmlFor="idea-reply" className="sr-only">{t("fb.reply.label")}</label>
        <textarea id="idea-reply" rows={3} maxLength={IDEA_LIMITS.reply} required value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("idea.talk.placeholder")} />
        <button className="btn primary" disabled={busy || !body.trim()}>{t("fb.reply.submit")}</button>
      </form>
    </section>
  );
}
