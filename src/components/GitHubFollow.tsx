import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { githubInstallLink, githubRepos, type GitHubInfo } from "../lib/ai";
import { gitBranches, gitDeploy, gitDisconnect, GITHUB_RETURN_KEY, hostError, type GitChoice, type GitRow } from "../lib/hosting";

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

  useEffect(() => {
    githubRepos().then(setInfo).catch(() => setInfo({ configured: false, installUrl: null }));
  }, []);
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

  const connectGitHub = () => {
    try {
      sessionStorage.setItem(GITHUB_RETURN_KEY, window.location.pathname);
    } catch {
      /* comes back to Toki Connect instead */
    }
    window.location.assign(githubInstallLink(info!.installUrl!));
  };

  const run = async (what: "deploy" | "stop") => {
    if (!gameId) return;
    setBusy(true);
    setErr("");
    try {
      if (what === "deploy") {
        const r = await gitDeploy(gameId);
        if (!r.ok) setErr(t("git.failed", { error: r.error ?? "" }));
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
            <p className="sub">{t("git.error", { error: hostError(row.error) === "error" ? row.error : t(`host.err.${hostError(row.error)}`, { mb: "100 MB" }) })}</p>
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={() => run("deploy")} disabled={busy}>{busy ? t("git.deploying") : t("git.deployNow")}</button>
            <button type="button" className="linkish" onClick={() => setEditing((v) => !v)}>{t("git.change")}</button>
            <button type="button" className="linkish danger-text" onClick={() => run("stop")} disabled={busy}>{t("git.stop")}</button>
          </div>
        </div>
      )}

      {editing && (
        !info ? (
          <p className="check" aria-busy="true">{t("loading")}</p>
        ) : !info.configured || !info.installUrl ? (
          <p className="check warn">{t("git.off")}</p>
        ) : !info.repos?.length ? (
          <div className="drop">
            <p>{t("git.connectFirst")}</p>
            <button type="button" className="btn primary" onClick={connectGitHub}>{t("connect.githubConnect")}</button>
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
            <small><button type="button" className="linkish" onClick={connectGitHub}>{t("git.moreRepos")}</button></small>
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
