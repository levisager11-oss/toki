import { useId, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import {
  createPost, deviceSummary, FeedbackError, KINDS, LIMITS, similarPosts,
  type FeedbackKind, type FeedbackPost,
} from "../lib/feedback";

const device = () => deviceSummary(navigator.userAgent, window.screen?.width, window.screen?.height);

/** Form for a new bug report, idea or other post. */
export function FeedbackForm({ gameId, posts, kind: initialKind = "bug", onPosted, onCancel }: {
  /** null: feedback about Toki itself */
  gameId: string | null;
  /** Posts already on the board, to point out similar ones. */
  posts: FeedbackPost[];
  kind?: FeedbackKind;
  onPosted: (p: FeedbackPost) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [kind, setKind] = useState<FeedbackKind>(initialKind);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [withDevice, setWithDevice] = useState(true);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const info = useMemo(device, []);
  const similar = useMemo(() => (title.trim().length >= 4 ? similarPosts(title, posts) : []), [title, posts]);
  const isBug = kind === "bug";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) return setErr(t("fb.err.tooShort"));
    setBusy(true);
    setErr("");
    try {
      const p = await createPost({
        game_id: gameId,
        kind,
        title: title.trim(),
        body: body.trim(),
        device: isBug && withDevice && info ? info : null,
        private: isBug && priv,
      });
      onPosted(p);
    } catch (e) {
      setErr(t(e instanceof FeedbackError ? e.key : "error"));
      setBusy(false);
    }
  };

  return (
    <form className="form fb-form" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t("fb.form.newTitle")}</h2>
      <span className="label-text" id={`${id}-kind`}>{t("fb.form.kind")}</span>
      <div className="seg" role="radiogroup" aria-labelledby={`${id}-kind`}>
        {KINDS.map((k) => (
          <label key={k} className={kind === k ? "on" : ""}>
            <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
            {t(`fb.kind.${k}`)}
          </label>
        ))}
      </div>

      <label htmlFor={`${id}-title`}>{t("fb.form.title")}</label>
      <input
        id={`${id}-title`}
        required
        minLength={3}
        maxLength={LIMITS.title}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t(isBug ? "fb.form.titleBug" : kind === "idea" ? "fb.form.titleIdea" : "fb.form.titleOther")}
        autoComplete="off"
        autoFocus
      />
      {similar.length > 0 && (
        <div className="fb-similar" aria-live="polite">
          <span>{t("fb.form.similar")}</span>
          <ul>
            {similar.map((p) => (
              <li key={p.id}><Link to={`/feedback/${p.id}`}>{p.title}</Link> <span className="sub">· {t("fb.votes", { n: p.vote_count })}</span></li>
            ))}
          </ul>
        </div>
      )}

      <label htmlFor={`${id}-body`}>{t("fb.form.body")}</label>
      <textarea
        id={`${id}-body`}
        rows={5}
        maxLength={LIMITS.body}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t(isBug ? "fb.form.bodyBug" : kind === "idea" ? "fb.form.bodyIdea" : "fb.form.bodyOther")}
      />
      {body.length > LIMITS.body * 0.8 && <small>{body.length} / {LIMITS.body}</small>}

      {isBug && (
        <>
          {info && (
            <label className="fb-check">
              <input type="checkbox" checked={withDevice} onChange={(e) => setWithDevice(e.target.checked)} />
              <span>{t("fb.form.device")}: <span className="sub">{info}</span></span>
            </label>
          )}
          <label className="fb-check">
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
            <span>{t("fb.form.private")}</span>
          </label>
          <small>{t("fb.form.privateHelp")}</small>
        </>
      )}

      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{busy ? t("fb.form.sending") : t("fb.form.submit")}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t("form.cancel")}</button>
      </div>
    </form>
  );
}
