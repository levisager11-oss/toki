import { useEffect, useId, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import {
  createRelease, fixablePosts, RELEASE_LIMITS, ReleaseError, setFixes, updateRelease,
  type Fixable, type Release,
} from "../lib/releases";
import { KindTag } from "./FeedbackBits";
import { AiBox } from "./AiBits";
import { githubRepos, type GitHubInfo } from "../lib/ai";
import { assistError, draftRelease, useFreeAi } from "../lib/assist";

/** Posting or editing an update, and choosing the feedback it fixes. */
export function ReleaseForm({ gameId, release, suggestedVersion = "", suggestedSmallVersion = "", onSaved, onCancel }: {
  /** null: an update of Toki itself */
  gameId: string | null;
  /** The update to edit; none for a new one. */
  release?: Release;
  suggestedVersion?: string;
  /** The version to suggest when "small update" is ticked, e.g. 1.2.1. */
  suggestedSmallVersion?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const freeAi = useFreeAi();
  const [version, setVersion] = useState(release?.version ?? suggestedVersion);
  const [small, setSmall] = useState(release?.small ?? false);
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

  // Ticking "small update" swaps the suggested version, unless the player typed their own.
  const toggleSmall = (on: boolean) => {
    setSmall(on);
    if (release) return;
    const [from, to] = on ? [suggestedVersion, suggestedSmallVersion] : [suggestedSmallVersion, suggestedVersion];
    if (version === from && to) setVersion(to);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const input = { version: version.trim(), title: title.trim() || null, notes: notes.trim(), small };
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
      <label className="fb-check">
        <input type="checkbox" checked={small} onChange={(e) => toggleSmall(e.target.checked)} />
        <span>{t("rel.form.small")} <span className="sub">· {t("rel.form.smallHelp")}</span></span>
      </label>
      {freeAi && !release && (
        <ReleaseDraft
          gameId={gameId}
          fixes={[...picked]}
          onUse={(d) => {
            if (d.title) setTitle(d.title.slice(0, RELEASE_LIMITS.title));
            setNotes(d.notes.slice(0, RELEASE_LIMITS.notes));
          }}
        />
      )}
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

const repoKey = (gameId: string | null) => `toki.releaseRepo.${gameId ?? "toki"}`;

/** "Write with AI": a draft from a few words, the ticked feedback and the code's changes on GitHub. */
function ReleaseDraft({ gameId, fixes, onUse }: { gameId: string | null; fixes: string[]; onUse: (d: { title: string; notes: string }) => void }) {
  const { t, lang } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [repos, setRepos] = useState<NonNullable<GitHubInfo["repos"]> | null>(null);
  const [repo, setRepo] = useState(() => {
    try {
      return localStorage.getItem(repoKey(gameId)) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<{ title: string; notes: string; commits: number; commitsError: boolean } | null>(null);

  useEffect(() => {
    if (!open || repos) return;
    githubRepos().then((g) => setRepos(g.repos ?? [])).catch(() => setRepos([]));
  }, [open, repos]);

  const write = async () => {
    setBusy(true);
    setErr("");
    const [inst, name] = repo.split("|");
    try {
      localStorage.setItem(repoKey(gameId), repo);
    } catch {
      /* only a convenience */
    }
    try {
      setDraft(await draftRelease({ game_id: gameId, notes: notes.trim(), fixes, lang, ...(name ? { installation_id: Number(inst), repo: name } : {}) }));
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };

  if (!open)
    return (
      <button type="button" className="linkish ai-link" onClick={() => setOpen(true)}>{t("rel.ai.open")}</button>
    );
  return (
    <div className="ai-panel">
      <label htmlFor={`${id}-w`}>{t("rel.ai.notes")}</label>
      <textarea id={`${id}-w`} rows={2} maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("rel.ai.notesPlaceholder")} />
      {repos && repos.length > 0 && (
        <>
          <label htmlFor={`${id}-r`}>{t("rel.ai.repo")}</label>
          <select id={`${id}-r`} value={repo} onChange={(e) => setRepo(e.target.value)} aria-describedby={`${id}-rh`}>
            <option value="">{t("rel.ai.noRepo")}</option>
            {repos.map((r) => <option key={`${r.installation_id}|${r.repo}`} value={`${r.installation_id}|${r.repo}`}>{r.repo}</option>)}
          </select>
          <small id={`${id}-rh`}>{t("rel.ai.repoHelp")}</small>
        </>
      )}
      <small>{t("rel.ai.help")}</small>
      <div className="actions">
        <button type="button" className="btn" onClick={write} disabled={busy}>{busy ? t("assist.writing") : t("rel.ai.write")}</button>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>{t("assist.close")}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {draft && (
        <AiBox title={t("rel.ai.draft")}>
          {draft.title && <p><b>{draft.title}</b></p>}
          <p className="fb-body">{draft.notes}</p>
          {draft.commitsError && <p className="check warn">{t("rel.ai.commitsError")}</p>}
          {draft.commits > 0 && <p className="sub">{t("rel.ai.commits", { n: draft.commits })}</p>}
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => onUse(draft)}>{t("assist.use")}</button>
          </div>
        </AiBox>
      )}
    </div>
  );
}
