import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import snippet from "../../public/toki-save.js?raw";
import { useI18n, type Key } from "../lib/i18n";
import { useAiStatus } from "../lib/assist";
import { ApiError, connectError, myJobs, type ConnectJob } from "../lib/ai";
import { GAME_UPDATES, gameRepos, NoSource, startUpdate, updateConnectPath, updateInstructions, updateKeys, updateState, type GameUpdate } from "../lib/gameUpdates";
import type { Game } from "../lib/types";

/**
 * "Updates for your games" on My games: what Toki can do now that needs a small change in the
 * developer's games (src/lib/gameUpdates.ts). Each game gets "Update with Toki Connect" (one
 * click starts the run), and the instructions can be copied for an AI agent instead.
 * Nothing while no update is for one of these games.
 */
export function DevUpdates({ games }: { games: Game[] }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<ConnectJob[]>([]);
  const [repos, setRepos] = useState<Record<string, { repo: string; branch: string }>>({});
  const updates = GAME_UPDATES.map((u) => ({ update: u, games: games.filter(u.applies) })).filter((x) => x.games.length > 0);
  const ids = [...new Set(updates.flatMap((x) => x.games.map((g) => g.id)))].sort().join(",");
  useEffect(() => {
    if (!ids) return;
    myJobs().then(setJobs, () => {});
    gameRepos(ids.split(",")).then(setRepos, () => {});
  }, [ids]);
  if (!updates.length) return null;
  return (
    <section className="dev-updates" aria-labelledby="dev-updates-h">
      <div className="sechead"><h2 id="dev-updates-h">{t("devup.title")}</h2></div>
      <p className="hint">{t("devup.lead")}</p>
      {updates.map((x) => <UpdateCard key={x.update.topic} update={x.update} games={x.games} jobs={jobs} repos={repos} />)}
    </section>
  );
}

function UpdateCard({ update, games, jobs, repos }: {
  update: GameUpdate; games: Game[]; jobs: ConnectJob[];
  /** The repository each game follows, if it follows one. */
  repos: Record<string, { repo: string; branch: string }>;
}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  // Toki Connect writes code with the strong AI: without it, the instructions are the way.
  const connect = useAiStatus().strong;
  const keys = updateKeys(update.topic);
  const [busy, setBusy] = useState("");
  // The error and the game it is about, so it shows under that game.
  const [err, setErr] = useState<{ game: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const start = async (game: Game) => {
    setBusy(game.id);
    setErr(null);
    try {
      navigate(`/connect/${(await startUpdate(update, game, repos[game.id], lang)).id}`);
    } catch (e) {
      // Toki can't reach this game's code with this account: the developer picks the repository.
      if (e instanceof NoSource) return navigate(updateConnectPath(update, game.id));
      setErr({ game: game.id, text: t(`connect.err.${connectError(e instanceof ApiError ? e.message : "error")}`) });
      setBusy("");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(updateInstructions(update, snippet));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="save-support dev-update" id={`update-${update.topic}`}>
      <b>{t(keys.title as Key)}</b>
      <p>{t(keys.text as Key)}</p>
      <ul className="dev-update-games">
        {games.map((g) => {
          const s = updateState(update, { id: g.id, repo: repos[g.id]?.repo }, jobs);
          const again = s.state === "todo" || s.state === "failed";
          return (
            <li key={g.id}>
              <span className="info">
                <b>{g.title}</b>
                {s.state === "run" && <span className="sub">{t("devup.running")} <Link to={`/connect/${s.job.id}`}>{t("connect.open")}</Link></span>}
                {s.state === "pr" && <span className="sub">✓ {t("devup.pr")} <a href={s.job.pr_url!} target="_blank" rel="noopener noreferrer">{t("connect.openPr")} ↗</a></span>}
                {s.state === "live" && <span className="sub">✓ {t("devup.live")}</span>}
                {s.state === "already" && <span className="sub">✓ {t("devup.already")}</span>}
                {s.state === "failed" && <span className="sub">{t("devup.failed")} <Link to={`/connect/${s.job.id}`}>{t("connect.open")}</Link></span>}
              </span>
              {again && connect && (
                <button type="button" className="btn primary" disabled={!!busy} onClick={() => start(g)}>
                  {busy === g.id ? t("connect.starting") : t("devup.connect")}
                </button>
              )}
              {err?.game === g.id && <p className="error" role="alert">{err.text}</p>}
            </li>
          );
        })}
      </ul>
      <div className="actions">
        <button type="button" className="btn" onClick={copy} aria-live="polite">{copied ? t("saveSupport.copied") : t("saveSupport.copyAgent")}</button>
        <span className="sub">{t(connect ? "devup.copyHelp" : "devup.copyOnly")}</span>
      </div>
    </div>
  );
}
