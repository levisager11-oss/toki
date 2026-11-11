import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import snippet from "../../public/toki-save.js?raw";
import { useI18n, type Key } from "../lib/i18n";
import { useAiStatus } from "../lib/assist";
import { ApiError, checkPrs, connectError, myJobs, type ConnectJob } from "../lib/ai";
import { GAME_UPDATES, gameRepos, isDone, markKey, NoSource, setUpdateMark, startUpdate, updateConnectPath, updateInstructions, updateKeys, updateMarks, updateState, type GameUpdate } from "../lib/gameUpdates";
import type { Game } from "../lib/types";

/**
 * "Updates for your games" on My games: what Toki can do now that needs a small change in the
 * developer's games (src/lib/gameUpdates.ts). Each game gets "Update with Toki Connect" (one
 * click starts the run), and the instructions can be copied for an AI agent instead.
 * Games that have the update (pull request merged, new version live, or had it already) drop
 * off, and so do games the developer marked "Already done" (they added it themselves); an update
 * drops off once all its games have it. Nothing while no update is left.
 */
export function DevUpdates({ games }: { games: Game[] }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<ConnectJob[]>([]);
  const [repos, setRepos] = useState<Record<string, { repo: string; branch: string }>>({});
  // Marked "Already done" (markKey keys), and the ones marked on this visit: those stay on the
  // card, with a way to take it back, until the page is opened again.
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const all = GAME_UPDATES.map((u) => ({ update: u, games: games.filter(u.applies) })).filter((x) => x.games.length > 0);
  const ids = [...new Set(all.flatMap((x) => x.games.map((g) => g.id)))].sort().join(",");
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    Promise.all([
      myJobs().then(async (list) => {
        // Pull requests Toki Connect opened: ask GitHub whether they were merged since.
        if (!list.some((j) => j.pr_url && (!j.pr_state || j.pr_state === "open"))) return list;
        const r = await checkPrs().catch(() => null);
        return r?.changed ? myJobs() : list;
      }).then((list) => alive && setJobs(list), () => {}),
      gameRepos(ids.split(",")).then((r) => alive && setRepos(r), () => {}),
      updateMarks(ids.split(",")).then((m) => alive && setMarks(m), () => {}),
    ]).finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [ids]);
  const mark = async (gameId: string, topic: string, done: boolean) => {
    await setUpdateMark(gameId, topic, done);
    const key = markKey(gameId, topic);
    const change = (set: Set<string>) => {
      const next = new Set(set);
      if (done) next.add(key);
      else next.delete(key);
      return next;
    };
    setMarks(change);
    setFresh(change);
  };
  // Until the runs are known, every game would look like it still needs the update.
  if (!loaded) return null;
  const updates = all
    .map((x) => ({
      ...x,
      games: x.games.filter((g) => {
        const key = markKey(g.id, x.update.topic);
        return !isDone(updateState(x.update, { id: g.id, repo: repos[g.id]?.repo }, jobs)) && (!marks.has(key) || fresh.has(key));
      }),
    }))
    .filter((x) => x.games.length > 0);
  if (!updates.length) return null;
  return (
    <section className="dev-updates" aria-labelledby="dev-updates-h">
      <div className="sechead"><h2 id="dev-updates-h">{t("devup.title")}</h2></div>
      <p className="hint">{t("devup.lead")}</p>
      {updates.map((x) => <UpdateCard key={x.update.topic} update={x.update} games={x.games} jobs={jobs} repos={repos} marks={marks} onMark={mark} />)}
    </section>
  );
}

function UpdateCard({ update, games, jobs, repos, marks, onMark }: {
  update: GameUpdate; games: Game[]; jobs: ConnectJob[];
  /** The repository each game follows, if it follows one. */
  repos: Record<string, { repo: string; branch: string }>;
  /** Marked "Already done" (markKey keys). */
  marks: Set<string>;
  onMark: (gameId: string, topic: string, done: boolean) => Promise<void>;
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
  const markDone = async (game: Game, done: boolean) => {
    setBusy(game.id);
    setErr(null);
    try {
      await onMark(game.id, update.topic, done);
    } catch {
      setErr({ game: game.id, text: t("devup.markFailed") });
    }
    setBusy("");
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
          const again = s.state === "todo" || s.state === "failed" || s.state === "closed";
          const marked = marks.has(markKey(g.id, update.topic));
          return (
            <li key={g.id}>
              <span className="info">
                <b>{g.title}</b>
                {marked && <span className="sub">✓ {t("devup.marked")}</span>}
                {!marked && s.state === "run" && <span className="sub">{t("devup.running")} <Link to={`/connect/${s.job.id}`}>{t("connect.open")}</Link></span>}
                {!marked && s.state === "pr" && <span className="sub">✓ {t("devup.pr")} <a href={s.job.pr_url!} target="_blank" rel="noopener noreferrer">{t("connect.openPr")} ↗</a></span>}
                {!marked && s.state === "closed" && <span className="sub">{t("devup.closed")}</span>}
                {!marked && s.state === "failed" && <span className="sub">{t("devup.failed")} <Link to={`/connect/${s.job.id}`}>{t("connect.open")}</Link></span>}
              </span>
              {marked ? (
                <button type="button" className="btn" disabled={!!busy} onClick={() => markDone(g, false)}>{t("devup.unmark")}</button>
              ) : (
                <span className="dev-update-buttons">
                  {again && connect && (
                    <button type="button" className="btn primary" disabled={!!busy} onClick={() => start(g)}>
                      {busy === g.id ? t("connect.starting") : t("devup.connect")}
                    </button>
                  )}
                  {s.state !== "run" && (
                    <button type="button" className="btn" disabled={!!busy} onClick={() => markDone(g, true)} title={t("devup.markHelp")}>
                      {t("devup.markDone")}
                    </button>
                  )}
                </span>
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
