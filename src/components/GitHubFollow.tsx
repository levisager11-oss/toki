import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/auth";
import { githubConnectLink, githubManage, githubRepos, type GitHubInfo } from "../lib/ai";
import { BUILD_WORKFLOW_PATH } from "../lib/hostingRules";
import { gitBranches, gitBuild, gitBuildStatus, gitDeploy, gitDisconnect, hostError, type BuildSetup, type BuildStatus, type GitChoice, type GitResult, type GitRow } from "../lib/hosting";

/** The error code of a failed update, also for GitHub's own answers saved before Toki knew them. */
export function gitErrorCode(error: string | null | undefined): string {
  const e = error ?? "";
  if (/^github: GitHub 40[34]\b/.test(e)) return "repo_lost";
  if (/^github: GitHub (5\d\d|429)\b/.test(e) || /rate limit|timed? ?out/i.test(e)) return "github_error";
  return e;
}

/** Why an update from GitHub failed, in words where Toki knows the reason. */
export function gitFailed(t: ReturnType<typeof useI18n>["t"], error: string | undefined, engine?: string): string {
  if (error === "cant_build") return t("git.cantBuild", { engine: engine && engine !== "unknown" ? engine : t("git.thisEngine") });
  const code = hostError(gitErrorCode(error));
  return code === "error" ? t("git.failed", { error: error ?? "" }) : t(`host.err.${code}`, { mb: "100 MB" });
}

/** How often the build panel asks GitHub while something is happening, and for how long at most. */
const POLL_MS = 10_000;
const POLL_FOR_MS = 15 * 60_000;

/**
 * GitHub Actions builds this game on every push. Shows, live while it's on screen, the two steps:
 * the build file (a pull request to merge, a permission to give on GitHub, or GitHub's reason for
 * saying no) and the newest build (running, live, or why it failed), each with its next step.
 */
export function BuildInfo({ gameId, repo, branch, setup, onChanged }: {
  gameId: string;
  repo: string;
  branch: string;
  /** what setting it up just said, until GitHub is asked */
  setup?: BuildSetup | null;
  onChanged?: () => void;
}) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [st, setSt] = useState<BuildStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryErr, setRetryErr] = useState("");
  const [tick, setTick] = useState(0);
  const since = useRef(Date.now());

  useEffect(() => {
    let gone = false;
    gitBuildStatus(gameId).then(
      (s) => { if (!gone) { setSt(s); setFailed(false); } },
      () => { if (!gone) setFailed(true); },
    );
    return () => { gone = true; };
  }, [gameId, tick]);

  // Asked again while something is happening (and the tab is open), and whenever the developer
  // comes back to this tab (e.g. from merging or allowing something on GitHub).
  const active = !!st && (st.file === "pr" || (st.file === "added" && (!st.run || st.run.state === "queued" || st.run.state === "running" || (st.run.state === "success" && !st.live))));
  useEffect(() => {
    const again = () => { if (!document.hidden) setTick((n) => n + 1); };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    const id = active && Date.now() - since.current < POLL_FOR_MS ? window.setInterval(again, POLL_MS) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
      if (id) window.clearInterval(id);
    };
  }, [active]);

  const retry = async () => {
    setBusy(true);
    setRetryErr("");
    try {
      const r = await gitBuild(gameId);
      if (!r.ok) setRetryErr(gitFailed(t, r.error, r.engine));
    } catch (e) {
      setRetryErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
    }
    setBusy(false);
    since.current = Date.now();
    setTick((n) => n + 1);
    onChanged?.();
  };

  const workflowPage = `https://github.com/${repo}/actions/workflows/${BUILD_WORKFLOW_PATH.split("/").pop()}`;
  const ext = { target: "_blank", rel: "noreferrer" } as const;
  // Until GitHub is asked: what setting it up said.
  const file = st?.file ?? (setup?.ready ? "added" : setup?.pr ? "pr" : "missing");
  const pr = st?.pr ?? setup?.pr ?? null;
  const manual = st?.manual ?? setup?.manual ?? null;
  const blocked = st ? st.blocked ?? (st.error?.startsWith("pr_refused: ") ? "refused" : null) : setup?.blocked ?? null;
  const permissionUrl = st?.permissionUrl ?? setup?.permissionUrl ?? null;
  const refusal = st?.error?.startsWith("pr_refused: ") ? st.error.slice("pr_refused: ".length) : setup?.error ?? "";
  const buildWhy = st?.error?.startsWith("build: ") ? st.error.slice("build: ".length) : "";
  const run = st?.run ?? null;
  const done = file === "added";
  const live = !!st?.live && (!run || run.state === "success" || run.state === "cancelled");
  const time = (s: string) => new Date(s).toLocaleTimeString(lang === "de" ? "de-CH" : "en", { hour: "2-digit", minute: "2-digit" });
  const admin = profile?.role === "admin";

  return (
    <div className="build-info" aria-live="polite">
      <p>{t("git.buildAction", { branch })}</p>
      <ol className="setup-steps build-steps">
        <li className={done ? "done" : "todo"}>
          <span className="setup-head">
            <span className={`setup-num ${done ? "done" : ""}`} aria-hidden="true">{done ? "✓" : 1}</span>
            <b>{t("git.build.fileTitle")}</b>
          </span>
          {!st && !setup ? (
            <p className="sub" aria-busy="true">{failed ? t("git.build.unknown") : t("loading")}</p>
          ) : done ? (
            <p className="sub">{t("git.build.fileIn")}</p>
          ) : file === "pr" && pr ? (
            <div className="setup-how">
              <p>{t("git.buildMergePr")}</p>
              <p><a className="btn primary" href={pr} {...ext}>{t("git.buildOpenPr")} ↗</a></p>
            </div>
          ) : blocked === "install" ? (
            <div className="setup-how">
              <p>{t("git.build.needInstall")}</p>
              <p>
                {permissionUrl && <a className="btn primary" href={permissionUrl} {...ext}>{t("git.build.allow")} ↗</a>}{" "}
                <button type="button" className="btn" onClick={retry} disabled={busy}>{busy ? t("git.deploying") : t("git.build.retry")}</button>
              </p>
              <small>{t("git.build.allowHow")}</small>
            </div>
          ) : blocked === "app" ? (
            <div className="setup-how">
              <p>{admin ? t("git.build.needAppAdmin") : t("git.build.needApp")}</p>
              {admin && permissionUrl && (
                <p>
                  <a className="btn primary" href={permissionUrl} {...ext}>{t("git.build.appPermissions")} ↗</a>{" "}
                  <button type="button" className="btn" onClick={retry} disabled={busy}>{busy ? t("git.deploying") : t("git.build.retry")}</button>
                </p>
              )}
            </div>
          ) : (
            <div className="setup-how">
              <p>{blocked === "refused" ? t("git.build.refused", { error: refusal || t("error") }) : t("git.build.noFile")}</p>
              <p><button type="button" className="btn primary" onClick={retry} disabled={busy}>{busy ? t("git.deploying") : blocked === "refused" ? t("git.build.retry") : t("git.build.openPr")}</button></p>
            </div>
          )}
          {!done && blocked && manual && (
            <small className="setup-how">{t("git.build.orByHand")} <a href={manual} {...ext}>{t("git.buildOpenNew")} ↗</a></small>
          )}
          {retryErr && <p className="error setup-how" role="alert">{retryErr}</p>}
        </li>

        <li className={live ? "done" : "todo"}>
          <span className="setup-head">
            <span className={`setup-num ${live ? "done" : ""}`} aria-hidden="true">{live ? "✓" : 2}</span>
            <b>{t("git.build.runTitle")}</b>
          </span>
          {!done ? (
            <p className="sub">{t("git.build.afterFile")}</p>
          ) : !run ? (
            <div className="setup-how">
              <p>{t("git.buildFirst")}</p>
              <p><a className="btn" href={workflowPage} {...ext}>{t("git.buildRunNow")} ↗</a></p>
            </div>
          ) : run.state === "queued" || run.state === "running" ? (
            <p className="sub" aria-busy="true">
              {t(run.state === "queued" ? "git.build.queued" : "git.build.running", { time: time(run.at) })}{" "}
              <a href={run.url} {...ext}>{t("git.build.watch")} ↗</a>
            </p>
          ) : run.state === "failed" ? (
            <div className="setup-how">
              <p className="check warn">{buildWhy ? t("git.build.failedWhy", { error: buildWhy }) : t("git.build.failed")}</p>
              <p>
                <a className="btn" href={run.url} {...ext}>{t("git.build.log")} ↗</a>{" "}
                <a className="btn" href={workflowPage} {...ext}>{t("git.build.runAgain")} ↗</a>
              </p>
            </div>
          ) : run.state === "cancelled" ? (
            <p className="sub">{t("git.build.cancelled")} <a href={workflowPage} {...ext}>{t("git.build.runAgain")} ↗</a></p>
          ) : live ? (
            <p className="sub">
              {t("git.build.live", { time: time(run.at) })}{" "}
              <a href={`https://github.com/${repo}/commit/${st?.last_sha ?? run.sha}`} {...ext}><code>{(st?.last_sha ?? run.sha).slice(0, 7)}</code></a>
            </p>
          ) : (
            <p className="sub" aria-busy="true">{t("git.build.uploading")}</p>
          )}
        </li>
      </ol>
      <small>
        {t("git.buildHow")} <a href={`https://github.com/${repo}/actions`} {...ext}>{t("git.buildRuns")} ↗</a>
      </small>
    </div>
  );
}

/**
 * Asked once when a repository holds the game's source: should GitHub Actions build it on every
 * push? "Not now" leaves it for later (the game's settings still offer it).
 */
export function BuildAsk({ onYes, onLater, busy }: { onYes: () => void; onLater?: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="check build-ask" role="group" aria-labelledby="build-ask-q">
      <p id="build-ask-q"><b>{t("git.ask.q")}</b></p>
      <p className="sub">{t("git.ask.why")}</p>
      <div className="actions">
        <button type="button" className="btn primary" onClick={onYes} disabled={busy}>{busy ? t("git.deploying") : t("git.ask.yes")}</button>
        {onLater && <button type="button" className="btn" onClick={onLater} disabled={busy}>{t("git.ask.later")}</button>}
      </div>
    </div>
  );
}

/**
 * "From GitHub" in the game form, like Vercel: pick a repository, a branch and the folder with
 * the game's index.html. Every push to that branch puts the new version on Toki.
 * A new game connects when the form is saved (GameForm); a connected game shows how the last
 * update went, and can update now or stop following.
 */
export function GitHubFollow({ gameId, row, choice, onChoice, onChanged }: {
  gameId?: string;
  row: GitRow | null;
  choice: GitChoice | null;
  onChoice: (c: GitChoice | null) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<GitHubInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(!row);
  // "Not now" on the question whether GitHub Actions should build the game.
  const [later, setLater] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const loadRepos = () =>
    githubRepos().then(
      (i) => {
        setInfo(i);
        setLoadFailed(false);
      },
      () => setLoadFailed(true),
    );
  useEffect(() => {
    loadRepos();
  }, []);
  // "More repositories" opens GitHub in a new tab; the list is read again when this tab is back.
  const stopWatching = useRef<() => void>();
  useEffect(() => () => stopWatching.current?.(), []);
  const moreRepos = (then?: () => void) => {
    stopWatching.current?.();
    stopWatching.current = githubManage(info!.installUrl!, () => {
      void loadRepos();
      then?.();
    });
  };
  useEffect(() => {
    setEditing(!row);
  }, [row]);

  const pickRepo = async (value: string) => {
    setErr("");
    const repo = info?.repos?.find((r) => `${r.installation_id}:${r.repo}` === value);
    if (!repo) return onChoice(null);
    onChoice({ installation_id: repo.installation_id, repo: repo.repo, branch: "", folder: choice?.folder ?? "" });
    try {
      const b = await gitBranches(repo.installation_id, repo.repo);
      setBranches(b.branches);
      onChoice({ installation_id: repo.installation_id, repo: repo.repo, branch: b.default, folder: choice?.folder ?? "" });
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
    }
  };

  const connectGitHub = () => window.location.assign(githubConnectLink(info!, window.location.pathname));

  const run = async (what: "deploy" | "stop" | "build") => {
    if (!gameId) return;
    setBusy(true);
    setErr("");
    try {
      if (what === "deploy" || what === "build") {
        const r: GitResult = what === "build" ? await gitBuild(gameId) : await gitDeploy(gameId);
        if (!r.ok) setErr(gitFailed(t, r.error, r.engine));
      } else await gitDisconnect(gameId);
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
    }
    setBusy(false);
    onChanged();
  };

  const date = (s: string) => new Date(s).toLocaleString(lang === "de" ? "de-CH" : "en", { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="host-box">
      {row && (
        <div className={`check ${row.status === "failed" ? "warn" : row.status === "live" ? "good" : ""}`} aria-live="polite">
          <p>
            <b>{t(`git.status.${row.status}`)}</b>{" "}
            {t("git.follows", { repo: row.repo, branch: row.branch })}
            {row.folder ? ` · ${row.folder}/` : ""}
          </p>
          {row.last_sha && (
            <p className="sub">
              <a href={`https://github.com/${row.repo}/commit/${row.last_sha}`} target="_blank" rel="noreferrer"><code>{row.last_sha.slice(0, 7)}</code></a>
              {row.last_message ? ` “${row.last_message}”` : ""} · {date(row.updated_at)}
            </p>
          )}
          {/* The build panel below says why a build failed, and asks about building. */}
          {row.status === "failed" && row.error && row.error !== "needs_build" && !(row.build === "action" && /^(build|pr_refused): /.test(row.error)) && (
            <p className="sub">{t("git.error", { error: hostError(gitErrorCode(row.error)) === "error" ? row.error : t(`host.err.${hostError(gitErrorCode(row.error))}`, { mb: "100 MB" }) })}</p>
          )}
          {row.status === "failed" && gitErrorCode(row.error) === "repo_lost" && info?.installUrl && (
            <p className="sub">
              {/* Back from GitHub, Toki tries the update again by itself. */}
              <button type="button" className="btn primary" onClick={() => moreRepos(() => run("deploy"))} disabled={busy}>{t("git.giveAccess")}</button>
            </p>
          )}
          {row.build === "action" && gameId && <BuildInfo gameId={gameId} repo={row.repo} branch={row.branch} onChanged={onChanged} />}
          {row.build !== "action" && row.error === "needs_build" && (
            later ? (
              <p className="sub">
                {t("git.buildOffer")}{" "}
                <button type="button" className="linkish" onClick={() => run("build")} disabled={busy}>{t("git.buildStart")}</button>
              </p>
            ) : (
              <BuildAsk busy={busy} onYes={() => run("build")} onLater={() => setLater(true)} />
            )
          )}
          <div className="actions">
            {row.build !== "action" && <button type="button" className="btn" onClick={() => run("deploy")} disabled={busy}>{busy ? t("git.deploying") : t("git.deployNow")}</button>}
            <button type="button" className="linkish" onClick={() => setEditing((v) => !v)}>{t("git.change")}</button>
            <button type="button" className="linkish danger-text" onClick={() => run("stop")} disabled={busy}>{t("git.stop")}</button>
          </div>
        </div>
      )}

      {editing && (
        loadFailed && !info ? (
          <div className="drop">
            <p>{t("connect.githubLoadError")}</p>
            <button type="button" className="btn" onClick={loadRepos}>{t("tryAgain")}</button>
          </div>
        ) : !info ? (
          <p className="check" aria-busy="true">{t("loading")}</p>
        ) : !info.configured || !info.installUrl ? (
          <p className="check warn">{t("git.off")}</p>
        ) : !info.installations?.length ? (
          <div className="drop">
            <p>{t("git.connectFirst")}</p>
            <button type="button" className="btn primary" onClick={connectGitHub}>{t("connect.githubConnect")}</button>
          </div>
        ) : !info.repos?.length ? (
          <div className="drop">
            <p>{info.unreachable ? t("connect.githubLoadError") : t("connect.noRepos")}</p>
            <div className="actions">
              {!info.unreachable && <button type="button" className="btn primary" onClick={() => moreRepos()}>{t("git.moreRepos")}</button>}
              <button type="button" className="btn" onClick={loadRepos}>{t("git.refreshRepos")}</button>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor="git-repo">{t("git.repo")}</label>
            <select id="git-repo" value={choice ? `${choice.installation_id}:${choice.repo}` : ""} onChange={(e) => pickRepo(e.target.value)}>
              <option value="">{t("git.pickRepo")}</option>
              {info.repos.map((r) => (
                <option key={`${r.installation_id}:${r.repo}`} value={`${r.installation_id}:${r.repo}`}>{r.repo}{r.private ? ` (${t("git.private")})` : ""}</option>
              ))}
            </select>
            <small>
              <button type="button" className="linkish" onClick={() => moreRepos()}>{t("git.moreRepos")}</button>
              {" · "}
              <button type="button" className="linkish" onClick={loadRepos}>{t("git.refreshRepos")}</button>
            </small>
            {!!info.hidden && (
              <small>
                {t("connect.hiddenRepos")}{" "}
                <button type="button" className="linkish" onClick={connectGitHub}>{t("connect.githubAgain")}</button>
              </small>
            )}
            {choice && (
              <div className="pair">
                <div>
                  <label htmlFor="git-branch">{t("git.branch")}</label>
                  <select id="git-branch" value={choice.branch} onChange={(e) => onChoice({ ...choice, branch: e.target.value })}>
                    {(branches.length ? branches : [choice.branch]).filter(Boolean).map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="git-folder">{t("git.folder")}</label>
                  <input id="git-folder" maxLength={200} placeholder={t("git.folderPlaceholder")} value={choice.folder} onChange={(e) => onChoice({ ...choice, folder: e.target.value })} />
                </div>
              </div>
            )}
            <small>{t("git.help")}</small>
          </>
        )
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
