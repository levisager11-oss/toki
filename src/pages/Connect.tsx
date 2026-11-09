import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import {
  ApiError, connectError, githubDisconnect, githubInstallLink, githubRepos, myBudget, myJobs, startJob, usd,
  type Budget, type ConnectJob, type Feature, type GitHubInfo,
} from "../lib/ai";

/** Toki Connect for developers: connect GitHub, start a run, see earlier runs (/connect). */
export function Connect() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const { games } = useGames();
  const location = useLocation();
  const navigate = useNavigate();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [gh, setGh] = useState<GitHubInfo | null>(null);
  const [jobs, setJobs] = useState<ConnectJob[] | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const githubDone = (location.state as { github?: string } | null)?.github === "done";

  useEffect(() => {
    myBudget().then(setBudget).catch(() => setError(true));
    myJobs().then(setJobs).catch(() => setError(true));
    githubRepos().then(setGh).catch(() => setGh({ configured: false, installUrl: null }));
  }, [reload]);

  useEffect(() => {
    document.title = `${t("connect.title")} · Toki`;
    return () => {
      document.title = "Toki";
    };
  }, [t]);

  const mine = useMemo(() => (games ?? []).filter((g) => profile && (profile.role === "admin" || g.created_by === profile.id)), [games, profile]);
  if (error) return <p className="msg">{t("error")}</p>;
  if (!budget || !jobs || !gh) return <p className="msg" aria-busy="true">{t("loading")}</p>;

  const active = jobs.find((j) => j.status === "working" || j.status === "question");
  const overQuota = budget.quota !== null && budget.spent >= budget.quota;
  const blocked = !budget.enabled ? t("connect.off") : budget.cap_reached ? t("connect.capReached") : overQuota ? t("connect.quotaReached") : "";
  const pct = budget.quota ? Math.min(100, (budget.spent / budget.quota) * 100) : 0;

  return (
    <section className="fb-board connect">
      <h1 className="h">{t("connect.title")}</h1>
      <p className="lead">{t("connect.lead")}</p>

      <div className="ai-card connect-budget">
        <p>{budget.quota === null ? t("connect.budgetAdmin", { spent: usd(budget.spent) }) : t("connect.budget", { spent: usd(budget.spent), quota: usd(budget.quota) })}</p>
        {budget.quota !== null && (
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("ai.month")}>
            <i className={pct >= 80 ? "warn" : ""} style={{ width: `${pct}%` }} />
          </div>
        )}
        {blocked && <p className="check warn">{blocked}</p>}
      </div>

      <section className="ai-card" aria-labelledby="gh-h">
        <h2 id="gh-h">{t("connect.github")}</h2>
        {githubDone && <p className="check good" role="status">{t("connect.githubDone")}</p>}
        {!gh.configured || !gh.installUrl ? (
          <p className="hint">{t("connect.githubOff")}</p>
        ) : !gh.installations?.length ? (
          <>
            <p className="hint">{t("connect.githubHelp")}</p>
            <button type="button" className="btn primary" onClick={() => window.location.assign(githubInstallLink(gh.installUrl!))}><GitHubMark />{t("connect.githubConnect")}</button>
          </>
        ) : (
          <>
            <ul className="gh-accounts">
              {gh.installations.map((i) => (
                <li key={i.installation_id}>
                  <span><GitHubMark />{t("connect.githubAccount", { name: i.account_login })}</span>
                  <button type="button" className="linkish" onClick={() => githubDisconnect(i.installation_id).then(() => setReload((n) => n + 1))}>{t("connect.disconnect")}</button>
                </li>
              ))}
            </ul>
            {!gh.repos?.length && <p className="hint">{t("connect.noRepos")}</p>}
            <button type="button" className="linkish" onClick={() => window.location.assign(githubInstallLink(gh.installUrl!))}>{t("connect.githubMore")}</button>
          </>
        )}
      </section>

      {active ? (
        <div className="check">
          <p>{t("connect.active")} <Link to={`/connect/${active.id}`}>{t("connect.open")}</Link></p>
        </div>
      ) : (
        gh.repos && gh.repos.length > 0 && !blocked && (
          <NewRun
            repos={gh.repos}
            games={mine.map((g) => ({ id: g.id, title: g.title }))}
            initialGame={new URLSearchParams(location.search).get("game") ?? ""}
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
                    <span>{j.features.map((f) => t(f === "saves" ? "connect.saves" : "connect.scores")).join(" + ")}</span>
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

function NewRun({ repos, games, initialGame, lang, onStarted }: {
  repos: NonNullable<GitHubInfo["repos"]>;
  games: { id: string; title: string }[];
  /** A game to preselect (from "Add with Toki Connect" on the game's form). */
  initialGame: string;
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
  const [features, setFeatures] = useState<Feature[]>(["saves", "scores"]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggle = (f: Feature) => setFeatures((list) => (list.includes(f) ? list.filter((x) => x !== f) : [...list, f]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!features.length) return;
    const [inst, name] = repo.split("|");
    setBusy(true);
    setErr("");
    try {
      const job = await startJob({ installation_id: Number(inst), repo: name, features, notes: notes.trim(), game_id: game || null, lang });
      onStarted(job.id);
    } catch (e) {
      setErr(t(`connect.err.${connectError(e instanceof ApiError ? e.message : "error")}`));
      setBusy(false);
    }
  };

  return (
    <form className="form fb-form" onSubmit={submit} aria-labelledby="new-run-h">
      <h2 id="new-run-h">{t("connect.new")}</h2>
      <label htmlFor="run-repo">{t("connect.repo")}</label>
      <select id="run-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={`${r.installation_id}|${r.repo}`} value={`${r.installation_id}|${r.repo}`}>{r.repo}{r.private ? " 🔒" : ""}</option>
        ))}
      </select>
      <label htmlFor="run-game">{t("connect.game")}</label>
      <select id="run-game" value={game} onChange={(e) => setGame(e.target.value)} aria-describedby="run-game-help">
        <option value="">{t("connect.noGame")}</option>
        {games.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
      </select>
      <small id="run-game-help">{t("connect.gameHelp")}</small>
      <span className="label-text">{t("connect.features")}</span>
      <label className="fb-check">
        <input type="checkbox" checked={features.includes("saves")} onChange={() => toggle("saves")} />
        <span><b>{t("connect.saves")}</b> <span className="sub">{t("connect.savesHelp")}</span></span>
      </label>
      <label className="fb-check">
        <input type="checkbox" checked={features.includes("scores")} onChange={() => toggle("scores")} />
        <span><b>{t("connect.scores")}</b> <span className="sub">{t("connect.scoresHelp")}</span></span>
      </label>
      <label htmlFor="run-notes">{t("connect.notes")}</label>
      <textarea id="run-notes" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("connect.notesPlaceholder")} />
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy || !features.length}>{busy ? t("connect.starting") : t("connect.start")}</button>
      </div>
    </form>
  );
}
