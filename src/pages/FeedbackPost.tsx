import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useVotes } from "../lib/useVotes";
import {
  addReply, ago, canManage, deletePost, deleteReply, FeedbackError, getPost, isClosed, KINDS, LIMITS, listReplies, STATUSES,
  updatePost, updateReply, type FeedbackPost as Post, type FeedbackReply, type PostChange,
} from "../lib/feedback";
import { FixedIn, PostMeta, useStatusLabel, VoteButton } from "../components/FeedbackBits";
import { useAiStatus } from "../lib/assist";
import { TranslateToggle, useTranslate } from "../components/AiBits";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One bug report or idea with its replies (/feedback/:id). */
export function FeedbackPost() {
  const { id = "" } = useParams();
  const { t, lang } = useI18n();
  const { session, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const statusLabel = useStatusLabel();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  const [replies, setReplies] = useState<FeedbackReply[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const posted = (location.state as { posted?: boolean } | null)?.posted === true;
  const list = post ? [post] : null;
  const tr = useTranslate("post", post?.id ?? id, post ? `${post.title}\n${post.body}` : "");
  // "Fix with AI" needs the strong AI.
  const { strong } = useAiStatus();
  const { voted, vote } = useVotes(list, (f) => setPost((p) => (p ? f([p])[0] : p)));

  useEffect(() => {
    if (!UUID.test(id)) {
      setPost(null);
      return;
    }
    let alive = true;
    setPost(undefined);
    Promise.all([getPost(id), listReplies(id)])
      .then(([p, r]) => {
        if (!alive) return;
        setPost(p);
        setReplies(r);
      })
      .catch(() => alive && setPost(null));
    return () => {
      alive = false;
    };
    // Reload when logging in or out: what the account may see changes.
  }, [id, session?.user.id]);

  useEffect(() => {
    if (post) document.title = `${post.title} · Toki`;
    return () => {
      document.title = "Toki";
    };
  }, [post]);

  if (post === undefined)
    return (
      <section className="fb-post skel" aria-busy="true" aria-label={t("loading")}>
        <span className="bar" style={{ width: "30%" }} />
        <span className="bar big" />
        <span className="bar" style={{ width: "80%" }} />
      </section>
    );
  if (post === null)
    return (
      <div className="msg">
        <p>{t("fb.post.notFound")}</p>
        <Link to="/feedback" className="btn">{t("fb.post.allToki")}</Link>
      </div>
    );

  const me = profile ? { id: profile.id, role: profile.role } : null;
  const isAuthor = !!me && me.id === post.author_id;
  const manager = canManage(post, me);
  const board = post.game ? `/game/${post.game.slug}/feedback` : "/feedback";

  /** true when it worked */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    let ok = true;
    try {
      await fn();
    } catch (e) {
      setError(t(e instanceof FeedbackError ? e.key : "error"));
      ok = false;
    }
    setBusy(false);
    return ok;
  };
  const change = (c: PostChange) => run(async () => setPost(await updatePost(post.id, c)));
  const remove = () =>
    run(async () => {
      await deletePost(post.id);
      navigate(board, { replace: true });
    });

  return (
    <article className="fb-post">
      <Link to={board} className="back">← {post.game ? t("fb.post.allFor", { title: post.game.title }) : t("fb.post.allToki")}</Link>
      {posted && <p className="check good" role="status">{t("fb.posted")}</p>}

      {editing ? (
        <EditPost post={post} busy={busy} onCancel={() => setEditing(false)} onSave={(c) => change(c).then((ok) => ok && setEditing(false))} />
      ) : (
        <>
          <header className="fb-head">
            <VoteButton post={post} voted={voted.has(post.id)} onVote={(on) => vote(post, on)} />
            <div className="fb-main">
              <h1>{tr.texts?.[0] ?? post.title}</h1>
              <PostMeta post={post} noRelease />
            </div>
          </header>
          {post.release && <p className="check good fb-fixed-note"><FixedIn post={post} /></p>}
          {post.private && <p className="check">{t("fb.post.privateNote")}</p>}
          {post.hidden && <p className="check warn">{t("fb.post.hiddenNote")}</p>}
          {post.body && <p className="fb-body">{tr.texts?.[1] ?? post.body}</p>}
          <TranslateToggle tr={tr} />
          <p className="sub fb-dates">
            {post.edited_at && <>{t("fb.post.edited")} {ago(post.edited_at, lang)} · </>}
            {post.status !== "open" && t("fb.post.statusChanged", { when: ago(post.status_at, lang) })}
          </p>
          {post.device && <p className="sub"><span className="label">{t("fb.post.device")}</span> {post.device}</p>}
          {isAuthor && (
            <div className="actions">
              <button type="button" className="btn" onClick={() => setEditing(true)}>{t("fb.post.edit")}</button>
              {confirmDelete ? (
                <>
                  <button type="button" className="btn danger" onClick={remove} disabled={busy}>{t("fb.post.confirmDelete")}</button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>{t("form.cancel")}</button>
                </>
              ) : (
                <button type="button" className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>{t("fb.post.delete")}</button>
              )}
            </div>
          )}
        </>
      )}

      {manager && !editing && (
        <section className="fb-manage" aria-labelledby="fb-manage-h">
          <h2 id="fb-manage-h" className="label">{t("fb.post.manage")}</h2>
          <div className="fb-manage-row">
            <label>
              <span className="label-text">{t("fb.post.status")}</span>
              <select value={post.status} disabled={busy} onChange={(e) => change({ status: e.target.value as Post["status"] })}>
                {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(post.kind, s)}</option>)}
              </select>
            </label>
            <button type="button" className="btn" disabled={busy} onClick={() => change({ hidden: !post.hidden })}>
              {post.hidden ? t("fb.post.unhide") : t("fb.post.hide")}
            </button>
            {strong && post.kind === "bug" && !isClosed(post.status) && (
              <Link to={`/connect?fix=${post.id}`} className="btn" title={t("fb.post.fixAiHelp")}>{t("fb.post.fixAi")}</Link>
            )}
            {!isAuthor && me?.role === "admin" && (
              confirmDelete ? (
                <button type="button" className="btn danger" onClick={remove} disabled={busy}>{t("fb.post.confirmDelete")}</button>
              ) : (
                <button type="button" className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>{t("fb.post.delete")}</button>
              )
            )}
          </div>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <Replies post={post} replies={replies} setReplies={setReplies} manager={manager} onReplied={() => getPost(post.id).then((p) => p && setPost(p)).catch(() => {})} />
    </article>
  );
}

function EditPost({ post, busy, onSave, onCancel }: { post: Post; busy: boolean; onSave: (c: PostChange) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState(post.kind);
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [priv, setPriv] = useState(post.private);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ kind, title: title.trim(), body: body.trim(), private: kind === "bug" && priv });
  };
  return (
    <form className="form fb-form" onSubmit={submit}>
      <span className="label-text" id="edit-kind">{t("fb.form.kind")}</span>
      <div className="seg" role="radiogroup" aria-labelledby="edit-kind">
        {KINDS.map((k) => (
          <label key={k} className={kind === k ? "on" : ""}>
            <input type="radio" name="edit-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            {t(`fb.kind.${k}`)}
          </label>
        ))}
      </div>
      <label htmlFor="edit-title">{t("fb.form.title")}</label>
      <input id="edit-title" required minLength={3} maxLength={LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="edit-body">{t("fb.form.body")}</label>
      <textarea id="edit-body" rows={6} maxLength={LIMITS.body} value={body} onChange={(e) => setBody(e.target.value)} />
      {kind === "bug" && (
        <label className="fb-check">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span>{t("fb.form.private")}</span>
        </label>
      )}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{t("fb.post.save")}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t("form.cancel")}</button>
      </div>
    </form>
  );
}

function Replies({ post, replies, setReplies, manager, onReplied }: {
  post: Post;
  replies: FeedbackReply[];
  setReplies: (f: (r: FeedbackReply[]) => FeedbackReply[]) => void;
  manager: boolean;
  onReplied: () => void;
}) {
  const { t, lang } = useI18n();
  const { session, profile } = useAuth();
  const location = useLocation();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(t(e instanceof FeedbackError ? e.key : "error"));
    }
    setBusy(false);
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    run(async () => {
      const r = await addReply(post.id, body.trim());
      setReplies((list) => [...list, r]);
      setBody("");
      onReplied();
    });
  };
  const save = (id: string) =>
    run(async () => {
      const r = await updateReply(id, draft.trim());
      setReplies((list) => list.map((x) => (x.id === id ? r : x)));
      setEditing(null);
    });
  const remove = (id: string) =>
    run(async () => {
      await deleteReply(id);
      setReplies((list) => list.filter((x) => x.id !== id));
      onReplied();
    });

  // The game's developer answers as "Developer"; admins who didn't make the game, as the Toki team.
  const badge = (r: FeedbackReply) => {
    if (!r.official) return null;
    if (post.game && r.author_id === post.game.created_by) return t("fb.byDev");
    return r.author?.role === "admin" ? t("fb.byTeam") : t("fb.byDev");
  };

  return (
    <section className="fb-replies-list" aria-labelledby="fb-replies-h">
      <h2 id="fb-replies-h">{t("fb.reply.title")}</h2>
      {replies.length === 0 && <p className="hint">{t("fb.reply.none")}</p>}
      <ol>
        {replies.map((r) => {
          const mine = profile?.id === r.author_id;
          return (
            <li key={r.id} className={r.official ? "official" : ""}>
              <div className="fb-reply-head">
                <b>@{r.author?.username ?? "?"}</b>
                {badge(r) && <span className="st st-planned">{badge(r)}</span>}
                <time className="sub" dateTime={r.created_at}>{ago(r.created_at, lang)}{r.edited_at ? ` · ${t("fb.post.edited")}` : ""}</time>
              </div>
              {editing === r.id ? (
                <div className="form">
                  <label htmlFor={`edit-${r.id}`} className="sr-only">{t("fb.reply.edit")}</label>
                  <textarea id={`edit-${r.id}`} rows={3} maxLength={LIMITS.reply} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="actions fb-form-actions">
                    <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => save(r.id)}>{t("fb.post.save")}</button>
                    <button type="button" className="btn" onClick={() => setEditing(null)}>{t("form.cancel")}</button>
                  </div>
                </div>
              ) : (
                <ReplyBody reply={r} />
              )}
              {(mine || manager) && editing !== r.id && (
                <div className="fb-reply-actions">
                  {mine && <button type="button" className="linkish" onClick={() => { setEditing(r.id); setDraft(r.body); }}>{t("fb.post.edit")}</button>}
                  <button type="button" className="linkish" disabled={busy} onClick={() => remove(r.id)}>{t("fb.reply.delete")}</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {err && <p className="error" role="alert">{err}</p>}
      {session ? (
        <form className="form fb-reply-form" onSubmit={send}>
          <label htmlFor="reply" className="sr-only">{t("fb.reply.label")}</label>
          <textarea id="reply" rows={3} maxLength={LIMITS.reply} required value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("fb.reply.placeholder")} />
          <button className="btn primary" disabled={busy || !body.trim()}>{t("fb.reply.submit")}</button>
        </form>
      ) : (
        <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="btn">{t("fb.reply.login")}</Link>
      )}
    </section>
  );
}

function ReplyBody({ reply }: { reply: FeedbackReply }) {
  const tr = useTranslate("reply", reply.id, reply.body);
  return (
    <>
      <p className="fb-body">{tr.texts?.[0] ?? reply.body}</p>
      <TranslateToggle tr={tr} />
    </>
  );
}
