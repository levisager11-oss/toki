import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago, getPost, type FeedbackPost } from "../lib/feedback";
import { useAiStatus } from "../lib/assist";
import {
  ApiError, connectError, githubConnectLink, githubDisconnect, githubManage, githubRepos, myBudget, myJobs, startJob, usd,
  type Budget, type ConnectJob, type Feature, type GitHubInfo,
} from "../lib/ai";
import { useTitle } from "../lib/useTitle";
import { updateFeatures, updateNotes, updatesFrom } from "../lib/gameUpdates";

/** Toki Connect for developers: connect GitHub, start a run, see earlier runs (/connect). */
export function Connect() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const { games } = useGames();
  const location = useLocation();
  const navigate = useNavigate();
  const [budget, setBudget] = useState<Budget | null>(null);
  // Without the strong AI, this page is only for connecting GitHub (the AI helpers read it too).
  const { strong } = useAiStatus();
  const [gh, setGh] = useState<GitHubInfo | null>(null);
  const [jobs, setJobs] = useState<ConnectJob[] | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  // Couldn't reach GitHub (not the same as "not set up")
  const [ghError, setGhError] = useState(false);
  // Shown once after coming back from GitHub, then forgotten so it doesn't stay after a disconnect.
  const [githubDone, setGithubDone] = useState(() => (location.state as { github?: string } | null)?.github === "done");
  useEffect(() => {
    if (githubDone) navigate(location.pathname + location.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "Fix with AI" on a bug report brings the developer here with ?fix=<post>.
  const fixId = new URLSearchParams(location.search).get("fix") ?? "";
  const [fixPost, setFixPost] = useState<FeedbackPost | null | undefined>(fixId ? undefined : null);
  useEffect(() => {
    if (!fixId) return setFixPost(null);
    getPost(fixId).then((p) => setFixPost(p?.kind === "bug" ? p : null)).catch(() => setFixPost(null));
  }, [fixId]);
  const [disconnecting, setDisconnecting] = useState<number | null>(null);
  const [confirmOff, setConfirmOff] = useState<number | null>(null);
  const [ghActionError, setGhActionError] = useState(false);
  const disconnect = (id: number) => {
    if (confirmOff !== id) return setConfirmOff(id);
    setDisconnecting(id);
    setGhActionError(false);
    setGithubDone(false);
    githubDisconnect(id)
      .then(() => setReload((n) => n + 1))
      .catch(() => setGhActionError(true))
      .finally(() => { setDisconnecting(null); setConfirmOff(null); });
  };

  useEffect(() => {
    myBudget().then(setBudget).catch(() => setError(true));
    myJobs().then(setJobs).catch(() => setError(true));
    githubRepos()
      .then((g) => {
        setGh(g);
        setGhError(false);
      })
      .catch((e) => {
        // "not_configured" from the server means the app isn't set up; anything else is a hiccup.
        const off = e instanceof ApiError && /not_configured/.test(e.message);
        setGh({ configured: false, installUrl: null });
        setGhError(!off);
      });
  }, [reload]);

  useTitle(t("connect.title"));

  const mine = useMemo(() => (games ?? []).filter((g) => profile && (profile.role === "admin" || g.created_by === profile.id)), [games, profile]);
  if (error) return <p className="msg">{t("error")}</p>;
  if (!budget || !jobs || !gh || fixPost === undefined) return <p className="msg" aria-busy="true">{t("loading")}</p>;

  const active = jobs.find((j) => j.status === "working" || j.status === "question");
  const overQuota = budget.quota !== null && budget.spent >= budget.quota;
  const blocked = !budget.enabled ? t("connect.off") : budget.cap_reached ? t("connect.capReached") : overQuota ? t("connect.quotaReached") : "";
  // A quota of $0 means none left, so the meter is full.
  const pct = budget.quota === null ? 0 : budget.quota === 0 ? 100 : Math.min(100, (budget.spent / budget.quota) * 100);

  return (
    <section className="fb-board connect">
      <h1 className="h">{t("connect.title")}</h1>
      <p className="lead">{t(strong ? "connect.lead" : "connect.leadGithubOnly")}</p>

      {strong && <div className="ai-card connect-budget">
        <p>{budget.quota === null ? t("connect.budgetAdmin", { spent: usd(budget.spent) }) : t("connect.budget", { spent: usd(budget.spent), quota: usd(budget.quota) })}</p>
        {budget.quota !== null && (
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("ai.month")}>
            <i className={pct >= 80 ? "warn" : ""} style={{ width: `${pct}%` }} />
          </div>
        )}
        {blocked && <p className="check warn">{blocked}</p>}
      </div>}

      <section className="ai-card" aria-labelledby="gh-h">
        <h2 id="gh-h">{t("connect.github")}</h2>
        {githubDone && <p className="check good" role="status">{t("connect.githubDone")}</p>}
        {ghActionError && <p className="error" role="alert">{t("error")}</p>}
        {ghError ? (
          <div className="msg">
            <p className="error" role="alert">{t("connect.githubLoadError")}</p>
            <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>{t("tryAgain")}</button>
          </div>
        ) : !gh.configured || !gh.installUrl ? (
          <p className="hint">{t("connect.githubOff")}</p>
        ) : !gh.installations?.length ? (
          <>
            <p className="hint">{t("connect.githubHelp")}</p>
            <button type="button" className="btn primary" onClick={() => window.location.assign(githubConnectLink(gh))}><GitHubMark />{t("connect.githubConnect")}</button>
          </>
        ) : (
          <>
            <ul className="gh-accounts">
              {gh.installations.map((i) => (
                <li key={i.installation_id}>
                  <span><GitHubMark />{t("connect.githubAccount", { name: i.account_login })}</span>
                  <button type="button" className="linkish" disabled={disconnecting !== null} onClick={() => disconnect(i.installation_id)}>
                    {confirmOff === i.installation_id ? t("connect.disconnectSure") : t("connect.disconnect")}
                  </button>
                </li>
              ))}
            </ul>
            {!gh.repos?.length && <p className="hint">{t("connect.noRepos")}</p>}
            {gh.unreachable && <p className="check warn">{t("connect.githubLoadError")}</p>}
            {/* GitHub's page for this never comes back to Toki: it opens in a new tab, and the list is read again on return. */}
            <button type="button" className="linkish" onClick={() => githubManage(gh.installUrl!, () => setReload((n) => n + 1))}>{t("connect.githubMore")}</button>
          </>
        )}
      </section>

      {!strong ? null : active ? (
        <div className="check">
          <p>{t("connect.active")} <Link to={`/connect/${active.id}`}>{t("connect.open")}</Link></p>
        </div>
      ) : (
        gh.repos && gh.repos.length > 0 && !blocked && (
          <NewRun
            // A new form when the repositories change (e.g. after a disconnect), so the choice is never a removed one.
            key={gh.repos.map((r) => `${r.installation_id}|${r.repo}`).join(",")}
            repos={gh.repos}
            games={mine.map((g) => ({ id: g.id, title: g.title }))}
            initialGame={fixPost?.game_id ?? new URLSearchParams(location.search).get("game") ?? ""}
            fix={fixPost ? { id: fixPost.id, title: fixPost.title } : null}
            lang={lang}
            onStarted={(id) => navigate(`/connect/${id}`)}
          />
        )
      )}

      <section aria-labelledby="runs-h">
        <div className="sechead"><h2 id="runs-h">{t("connect.history")}</h2></div>
        {jobs.length === 0 ? (
          <p className="msg">{t("connect.noRuns")}</p>
        ) : (
          <ul className="fb-list">
            {jobs.map((j) => (
              <li key={j.id} className="fb-row">
                <div className="fb-main">
                  <Link to={`/connect/${j.id}`} className="fb-title">{j.repo}</Link>
                  <span className="fb-meta">
                    <JobBadge status={j.status} pr={!!j.pr_url} />
                    <span>{j.features.map((f) => t(featureKey(f))).join(" + ")}</span>
                    <time dateTime={j.created_at}>{ago(j.created_at, lang)}</time>
                    {j.pr_url && <a href={j.pr_url} target="_blank" rel="noopener noreferrer">{t("connect.openPr")} ↗</a>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

export const featureKey = (f: Feature) =>
  f === "fix" ? "connect.fix" : f === "saves" ? "connect.saves" : f === "multiplayer" ? "connect.multiplayer" : f === "achievements" ? "ach.connect" : f === "boards" ? "boards.connect" : "connect.scores";

/** pr: whether the run opened a pull request (a finished run without one found nothing to do). */
export function JobBadge({ status, pr }: { status: ConnectJob["status"]; pr: boolean }) {
  const { t } = useI18n();
  const cls = { working: "st-in_progress", question: "st-planned", done: "st-done", failed: "st-declined" }[status];
  return <span className={`st ${cls}`}>{t(status === "done" && !pr ? "connect.status.already" : `connect.status.${status}`)}</span>;
}

export const GitHubMark = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

function NewRun({ repos, games, initialGame, fix, lang, onStarted }: {
  repos: NonNullable<GitHubInfo["repos"]>;
  games: { id: string; title: string }[];
  /** A game to preselect (from "Add with Toki Connect" on the game's form). */
  initialGame: string;
  /** A bug report to fix, instead of adding features. */
  fix: { id: string; title: string } | null;
  lang: "en" | "de";
  onStarted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [repo, setRepo] = useState(`${repos[0].installation_id}|${repos[0].repo}`);
  const [game, setGame] = useState(() => (games.some((g) => g.id === initialGame) ? initialGame : ""));
  // The games may still be loading at first.
  const known = games.some((g) => g.id === initialGame);
  useEffect(() => {
    if (known) setGame((g) => g || initialGame);
  }, [known, initialGame]);
  // Coming from updates for developers' games (?update=<topic>,<topic>): their features are
  // ticked and the notes say what to add. ?add=<feature> ticks just that one.
  const [updates] = useState(() => updatesFrom(new URLSearchParams(location.search).get("update")));
  const [features, setFeatures] = useState<Feature[]>(() => {
    if (updates.length) return updateFeatures(updates);
    const add = new URLSearchParams(location.search).get("add");
    return add === "multiplayer" || add === "scores" || add === "saves" || add === "achievements" || add === "boards" ? [add] : ["saves", "scores"];
  });
  const [notes, setNotes] = useState(() => (updates.length ? updateNotes(updates) : ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggle = (f: Feature) => setFeatures((list) => (list.includes(f) ? list.filter((x) => x !== f) : [...list, f]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!features.length && !fix) return;
    const [inst, name] = repo.split("|");
    setBusy(true);
    setErr("");
    try {
      const job = await startJob({ installation_id: Number(inst), repo: name, features, notes: notes.trim(), game_id: game || null, lang, ...(fix ? { feedback_id: fix.id } : {}) });
      onStarted(job.id);
    } catch (e) {
      setErr(t(`connect.err.${connectError(e instanceof ApiError ? e.message : "error")}`));
      setBusy(false);
    }
  };

  return (
    <form className="form fb-form" onSubmit={submit} aria-labelledby="new-run-h">
      <h2 id="new-run-h">{fix ? t("connect.fixTitle") : t("connect.new")}</h2>
      {fix && (
        <div className="check">
          <p>{t("connect.fixLead")} <Link to={`/feedback/${fix.id}`}><b>{fix.title}</b></Link></p>
          <small>{t("connect.fixHelp")}</small>
        </div>
      )}
      <label htmlFor="run-repo">{t("connect.repo")}</label>
      <select id="run-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={`${r.installation_id}|${r.repo}`} value={`${r.installation_id}|${r.repo}`}>{r.repo}{r.private ? " 🔒" : ""}</option>
        ))}
      </select>
      <label htmlFor="run-game">{t("connect.game")}</label>
      <select id="run-game" value={game} onChange={(e) => setGame(e.target.value)} aria-describedby="run-game-help" disabled={!!fix}>
        <option value="">{t("connect.noGame")}</option>
        {games.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
      </select>
      <small id="run-game-help">{t("connect.gameHelp")}</small>
      {!fix && (
        <>
          <span className="label-text">{t("connect.features")}</span>
          <label className="fb-check">
            <input type="checkbox" checked={features.includes("saves")} onChange={() => toggle("saves")} />
            <span><b>{t("connect.saves")}</b> <span className="sub">{t("connect.savesHelp")}</span></span>
          </label>
          <label className="fb-check">
            <input type="checkbox" checked={features.includes("scores")} onChange={() => toggle("scores")} />
            <span><b>{t("connect.scores")}</b> <span className="sub">{t("connect.scoresHelp")}</span></span>
          </label>
          <label className="fb-check">
            <input type="checkbox" checked={features.includes("multiplayer")} onChange={() => toggle("multiplayer")} />
            <span><b>{t("connect.multiplayer")}</b> <span className="sub">{t("connect.multiplayerHelp")}</span></span>
          </label>
          <label className="fb-check">
            <input type="checkbox" checked={features.includes("achievements")} onChange={() => toggle("achievements")} />
            <span><b>{t("ach.connect")}</b> <span className="sub">{t("ach.connectHelp")}</span></span>
          </label>
          <label className="fb-check">
            <input type="checkbox" checked={features.includes("boards")} onChange={() => toggle("boards")} />
            <span><b>{t("boards.connect")}</b> <span className="sub">{t("boards.connectHelp")}</span></span>
          </label>
        </>
      )}
      <label htmlFor="run-notes">{t("connect.notes")}</label>
      <textarea id="run-notes" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("connect.notesPlaceholder")} />
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy || (!features.length && !fix)}>{busy ? t("connect.starting") : fix ? t("connect.fixStart") : t("connect.start")}</button>
      </div>
    </form>
  );
}
