import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { githubConnectLink, githubManage, githubRepos, type GitHubInfo } from "../lib/ai";
import { gitBranches, gitBuild, gitDeploy, gitDisconnect, hostError, type GitChoice, type GitResult, type GitRow } from "../lib/hosting";

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

/**
 * GitHub Actions builds this game on every push: where its build file is (a pull request to
 * merge, or GitHub's page to add it with one click), and "Run it once" on GitHub.
 */
export function BuildInfo({ repo, branch, link, ready }: { repo: string; branch: string; link: string | null | undefined; ready?: boolean }) {
  const { t } = useI18n();
  const isPr = !!link && /\/pull\/\d+/.test(link);
  return (
    <div className="build-info">
      <p>{t("git.buildAction", { branch })}</p>
      {!ready && link && (
        <p>
          <b>{isPr ? t("git.buildMergePr") : t("git.buildAddFile")}</b>{" "}
          <a className="btn" href={link} target="_blank" rel="noreferrer">{isPr ? t("git.buildOpenPr") : t("git.buildOpenNew")}</a>
        </p>
      )}
      <small>
        {t("git.buildHow")}{" "}
        <a href={`https://github.com/${repo}/actions`} target="_blank" rel="noreferrer">{t("git.buildRuns")}</a>
      </small>
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
          {row.status === "failed" && row.error && (
            <p className="sub">{t("git.error", { error: hostError(gitErrorCode(row.error)) === "error" ? row.error : t(`host.err.${hostError(gitErrorCode(row.error))}`, { mb: "100 MB" }) })}</p>
          )}
          {row.status === "failed" && gitErrorCode(row.error) === "repo_lost" && info?.installUrl && (
            <p className="sub">
              {/* Back from GitHub, Toki tries the update again by itself. */}
              <button type="button" className="btn primary" onClick={() => moreRepos(() => run("deploy"))} disabled={busy}>{t("git.giveAccess")}</button>
            </p>
          )}
          {row.build === "action" && <BuildInfo repo={row.repo} branch={row.branch} link={row.build_pr} ready={row.status === "live" || !!row.last_sha} />}
          {row.build !== "action" && row.error === "needs_build" && (
            <p className="sub">
              {t("git.buildOffer")}{" "}
              <button type="button" className="btn primary" onClick={() => run("build")} disabled={busy}>{t("git.buildStart")}</button>
            </p>
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
