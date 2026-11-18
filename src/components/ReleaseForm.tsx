import { useEffect, useId, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import {
  createRelease, fixablePosts, RELEASE_LIMITS, ReleaseError, setFixes, updateRelease,
  type Fixable, type Release,
} from "../lib/releases";
import { KindTag } from "./FeedbackBits";
import { AiBox } from "./AiBits";
import { githubConnectLink, githubRepos, type GitHubInfo } from "../lib/ai";
import { assistError, draftRelease, reviseRelease, useAiFeature, type ReleaseDraft as Draft } from "../lib/assist";

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
  const freeAi = useAiFeature("release");
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
          fixable={fixable ?? []}
          versionFor={(s) => (s ? suggestedSmallVersion : suggestedVersion)}
          onUse={(d) => {
            if (d.title) setTitle(d.title.slice(0, RELEASE_LIMITS.title));
            setNotes(d.notes.slice(0, RELEASE_LIMITS.notes));
            if (d.small !== null && d.small !== small) toggleSmall(d.small);
            if (d.fixes.length) setPicked((p) => new Set([...p, ...d.fixes]));
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

type Written = Extract<Draft, { notes: string }>;

/**
 * "Write with AI": a draft from a few words, the ticked feedback, the last updates and the code's
 * changes on GitHub (merged pull requests and commits). The AI may ask a few questions first; the
 * draft suggests a small or main update and feedback it takes care of, and can be changed by asking.
 */
function ReleaseDraft({ gameId, fixes, fixable, versionFor, onUse }: {
  gameId: string | null;
  fixes: string[];
  fixable: Fixable[];
  versionFor: (small: boolean) => string;
  onUse: (d: { title: string; notes: string; small: boolean | null; fixes: string[] }) => void;
}) {
  const { t, lang } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [gh, setGh] = useState<GitHubInfo | null>(null);
  const [repo, setRepo] = useState(() => {
    try {
      return localStorage.getItem(repoKey(gameId)) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [draft, setDraft] = useState<Written | null>(null);
  const [change, setChange] = useState("");
  const repos = gh?.repos ?? null;

  useEffect(() => {
    if (!open || gh) return;
    githubRepos().then(setGh).catch(() => setGh({ configured: false, installUrl: null, repos: [] }));
  }, [open, gh]);

  const write = async (more: { answers?: { q: string; a: string }[]; ask?: boolean } = {}) => {
    setBusy(true);
    setErr("");
    const [inst, name] = repo.split("|");
    try {
      localStorage.setItem(repoKey(gameId), repo);
    } catch {
      /* only a convenience */
    }
    try {
      const r = await draftRelease({ game_id: gameId, notes: notes.trim(), fixes, lang, ...(name ? { installation_id: Number(inst), repo: name } : {}), ...more });
      if ("questions" in r) {
        setQuestions(r.questions);
        setAnswers(r.questions.map(() => ""));
        setDraft(null);
      } else {
        setQuestions(null);
        setDraft(r);
        setChange("");
      }
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };

  const rewrite = async () => {
    if (!draft || !change.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await reviseRelease({ game_id: gameId, lang, title: draft.title, notes: draft.notes, change: change.trim() });
      setDraft({ ...draft, ...r });
      setChange("");
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };

  if (!open)
    return (
      <button type="button" className="linkish ai-link" onClick={() => setOpen(true)}>{t("rel.ai.open")}</button>
    );
  const suggested = draft ? fixable.filter((p) => draft.fixes.includes(p.id)) : [];
  const version = draft && draft.small !== null ? versionFor(draft.small) : "";
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
      {gh?.configured && repos?.length === 0 && (gh.authUrl || gh.installUrl) && (
        <p className="sub">
          {t("rel.ai.noGithub")}{" "}
          <button type="button" className="linkish" onClick={() => window.location.assign(githubConnectLink(gh, window.location.pathname))}>{t("rel.ai.connect")}</button>
        </p>
      )}
      <small>{t("rel.ai.help")}</small>
      <div className="actions">
        <button type="button" className="btn" onClick={() => write()} disabled={busy}>{busy && !questions && !draft ? t("assist.writing") : t("rel.ai.write")}</button>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>{t("assist.close")}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {questions && (
        <AiBox title={t("rel.ai.questions")}>
          {questions.map((q, i) => (
            <div key={i}>
              <label htmlFor={`${id}-q${i}`}>{q}</label>
              <input
                id={`${id}-q${i}`}
                maxLength={500}
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={t("rel.ai.answer")}
                autoComplete="off"
              />
            </div>
          ))}
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy || answers.every((a) => !a.trim())} onClick={() => write({ answers: questions.map((q, i) => ({ q, a: answers[i] ?? "" })) })}>
              {busy ? t("assist.writing") : t("rel.ai.write")}
            </button>
            <button type="button" className="linkish" disabled={busy} onClick={() => write({ ask: false })}>{t("rel.ai.skip")}</button>
          </div>
        </AiBox>
      )}
      {draft && (
        <AiBox title={t("rel.ai.draft")}>
          {draft.title && <p><b>{draft.title}</b></p>}
          <p className="fb-body">{draft.notes}</p>
          {draft.small !== null && <p className="sub">{t(draft.small ? "rel.ai.small" : "rel.ai.main", { v: version || "–" })}</p>}
          {suggested.length > 0 && (
            <>
              <p className="sub">{t("rel.ai.fixes")}</p>
              <ul className="rel-pick">
                {suggested.map((p) => <li key={p.id}><KindTag kind={p.kind} /> {p.title}</li>)}
              </ul>
            </>
          )}
          {draft.commitsError && <p className="check warn">{t("rel.ai.commitsError")}</p>}
          {draft.pulls > 0 && <p className="sub">{t("rel.ai.pulls", { n: draft.pulls })}</p>}
          {draft.commits > 0 && <p className="sub">{t("rel.ai.commits", { n: draft.commits })}</p>}
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => onUse({ ...draft, fixes: suggested.map((p) => p.id) })}>{t("assist.use")}</button>
          </div>
          <label htmlFor={`${id}-c`}>{t("rel.ai.change")}</label>
          <div className="actions rel-change">
            <input
              id={`${id}-c`}
              maxLength={300}
              value={change}
              onChange={(e) => setChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  rewrite();
                }
              }}
              placeholder={t("rel.ai.changePlaceholder")}
              autoComplete="off"
            />
            <button type="button" className="btn" disabled={busy || !change.trim()} onClick={rewrite}>{busy ? t("assist.writing") : t("rel.ai.rewrite")}</button>
          </div>
        </AiBox>
      )}
    </div>
  );
}
