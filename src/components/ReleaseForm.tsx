import { useEffect, useId, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import {
  createRelease, fixablePosts, RELEASE_LIMITS, ReleaseError, setFixes, updateRelease,
  type Fixable, type Release,
} from "../lib/releases";
import { KindTag } from "./FeedbackBits";

/** Posting or editing an update, and choosing the feedback it fixes. */
export function ReleaseForm({ gameId, release, suggestedVersion = "", onSaved, onCancel }: {
  /** null: an update of Toki itself */
  gameId: string | null;
  /** The update to edit; none for a new one. */
  release?: Release;
  suggestedVersion?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [version, setVersion] = useState(release?.version ?? suggestedVersion);
  const [title, setTitle] = useState(release?.title ?? "");
  const [notes, setNotes] = useState(release?.notes ?? "");
  const [fixable, setFixable] = useState<Fixable[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(release?.fixed.map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fixablePosts(gameId, release?.id)
      .then((list) => alive && setFixable(list))
      .catch(() => alive && setFixable([]));
    return () => {
      alive = false;
    };
  }, [gameId, release?.id]);

  const toggle = (postId: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const input = { version: version.trim(), title: title.trim() || null, notes: notes.trim() };
      const saved = release ? await updateRelease(release.id, input) : await createRelease(gameId, input);
      const before = new Set(release?.fixed.map((f) => f.id));
      const changed = picked.size !== before.size || [...picked].some((p) => !before.has(p));
      if (changed) await setFixes(saved.id, [...picked]);
      onSaved();
    } catch (e) {
      setErr(t(e instanceof ReleaseError ? e.key : "error"));
      setBusy(false);
    }
  };

  return (
    <form className="form fb-form rel-form" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{release ? t("rel.form.editTitle") : t("rel.form.newTitle")}</h2>
      <div className="pair">
        <div>
          <label htmlFor={`${id}-v`}>{t("rel.form.version")}</label>
          <input id={`${id}-v`} required maxLength={RELEASE_LIMITS.version} value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("rel.form.versionHelp")} autoComplete="off" autoFocus={!release} />
        </div>
        <div>
          <label htmlFor={`${id}-t`}>{t("rel.form.title")}</label>
          <input id={`${id}-t`} maxLength={RELEASE_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("rel.form.titleHelp")} autoComplete="off" />
        </div>
      </div>
      <label htmlFor={`${id}-n`}>{t("rel.form.notes")}</label>
      <small>{t("rel.form.notesHelp")}</small>
      <textarea id={`${id}-n`} rows={7} maxLength={RELEASE_LIMITS.notes} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("rel.form.notesPlaceholder")} />

      <span className="label-text" id={`${id}-f`}>{t("rel.form.fixes")}</span>
      <small>{t("rel.form.fixesHelp")}</small>
      {!fixable ? (
        <p className="hint">{t("loading")}</p>
      ) : fixable.length === 0 ? (
        <p className="hint">{t("rel.form.noFixable")}</p>
      ) : (
        <ul className="rel-pick" aria-labelledby={`${id}-f`}>
          {fixable.map((p) => (
            <li key={p.id}>
              <label className="fb-check">
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                <span><KindTag kind={p.kind} /> {p.title} <span className="sub">· {t("fb.votes", { n: p.vote_count })}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{busy ? t("rel.form.saving") : release ? t("fb.post.save") : t("rel.form.publish")}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>{t("form.cancel")}</button>
      </div>
    </form>
  );
}
