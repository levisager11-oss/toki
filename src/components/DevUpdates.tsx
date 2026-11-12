import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import snippet from "../../public/toki-save.js?raw";
import { useI18n, type Key } from "../lib/i18n";
import { useAiStatus } from "../lib/assist";
import { ApiError, checkPrs, connectError, myJobs, type ConnectJob } from "../lib/ai";
import { GAME_UPDATES, gameRepos, isDone, markKey, NoSource, setUpdateMark, startUpdate, updateConnectPath, updateInstructions, updateKeys, updateMarks, updateState, type GameUpdate, type UpdateState } from "../lib/gameUpdates";
import type { Game } from "../lib/types";

type Repos = Record<string, { repo: string; branch: string }>;

/**
 * "Updates for your games" on My games: what Toki can do now that needs a small change in the
 * developer's games (src/lib/gameUpdates.ts). One card lists what's new, and each game that is
 * missing something gets one "Update with Toki Connect" (one click starts one run that adds
 * everything the game is missing) and "Copy instructions" with all of it for an AI agent.
 * Updates a game has (pull request merged, new version live, or had it already) don't count,
 * and neither do the ones the developer marked "Already done" (they added them themselves); a
 * game drops off once it has everything. Nothing while no game is missing anything.
 */
export function DevUpdates({ games }: { games: Game[] }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<ConnectJob[]>([]);
  const [repos, setRepos] = useState<Repos>({});
  // Marked "Already done" (markKey keys), and the ones marked on this visit: those stay on the
  // card, with a way to take it back, until the page is opened again.
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const ids = [...new Set(games.filter((g) => GAME_UPDATES.some((u) => u.applies(g))).map((g) => g.id))].sort().join(",");
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
  const mark = async (gameId: string, topics: string[], done: boolean) => {
    await Promise.all(topics.map((topic) => setUpdateMark(gameId, topic, done)));
    const change = (set: Set<string>) => {
      const next = new Set(set);
      for (const topic of topics) {
        if (done) next.add(markKey(gameId, topic));
        else next.delete(markKey(gameId, topic));
      }
      return next;
    };
    setMarks(change);
    setFresh(change);
  };
  // Until the runs are known, every game would look like it still needs every update.
  if (!loaded) return null;
  const rows = games
    .map((g) => {
      const missing = GAME_UPDATES.filter((u) => u.applies(g) && !isDone(updateState(u, { id: g.id, repo: repos[g.id]?.repo }, jobs)));
      const marked = (u: GameUpdate) => marks.has(markKey(g.id, u.topic));
      return {
        game: g,
        // Still to add, and marked "Already done" on this visit (shown until the page is opened again).
        todo: missing.filter((u) => !marked(u)),
        marked: missing.filter((u) => marked(u) && fresh.has(markKey(g.id, u.topic))),
      };
    })
    .filter((r) => r.todo.length || r.marked.length);
  if (!rows.length) return null;
  const shown = GAME_UPDATES.filter((u) => rows.some((r) => r.todo.includes(u) || r.marked.includes(u)));
  return (
    <section className="dev-updates" aria-labelledby="dev-updates-h">
      <div className="sechead"><h2 id="dev-updates-h">{t("devup.title")}</h2></div>
      <p className="hint">{t("devup.lead")}</p>
      <div className="save-support dev-update">
        <ul className="dev-update-news">
          {shown.map((u) => (
            <li key={u.topic} id={`update-${u.topic}`}>
              <b>{t(updateKeys(u.topic).title as Key)}</b>
              <p>{t(updateKeys(u.topic).text as Key)}</p>
            </li>
          ))}
        </ul>
        <ul className="dev-update-games">
          {rows.map((r) => <GameRow key={r.game.id} game={r.game} todo={r.todo} marked={r.marked} jobs={jobs} repos={repos} onMark={mark} />)}
        </ul>
        <CopyHelp />
      </div>
    </section>
  );
}

function CopyHelp() {
  const { t } = useI18n();
  // Toki Connect writes code with the strong AI: without it, the instructions are the way.
  const connect = useAiStatus().strong;
  return <p className="sub">{t(connect ? "devup.copyHelp" : "devup.copyOnly")}</p>;
}

/** One game: what it is missing, and one button that adds all of it. */
function GameRow({ game, todo, marked, jobs, repos, onMark }: {
  game: Game;
  /** The updates the game is missing. */
  todo: GameUpdate[];
  /** The ones marked "Already done" on this visit. */
  marked: GameUpdate[];
  jobs: ConnectJob[];
  /** The repository each game follows, if it follows one. */
  repos: Repos;
  onMark: (gameId: string, topics: string[], done: boolean) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const connect = useAiStatus().strong;
  const [busy, setBusy] = useState<"" | "start" | "mark">("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const states = todo.map((u) => ({ update: u, s: updateState(u, { id: game.id, repo: repos[game.id]?.repo }, jobs) }));
  const jobOf = (state: UpdateState["state"]) => states.map((x) => x.s).find((s): s is Extract<UpdateState, { job: ConnectJob }> => s.state === state)?.job;
  const running = jobOf("run");
  const prs = [...new Map(states.flatMap((x) => (x.s.state === "pr" ? [[x.s.job.id, x.s.job] as const] : []))).values()];
  const failed = jobOf("failed");
  const closed = jobOf("closed");
  // What a new run adds: everything but what an open pull request already brings.
  const again = states.filter((x) => x.s.state === "todo" || x.s.state === "failed" || x.s.state === "closed").map((x) => x.update);

  const start = async () => {
    setBusy("start");
    setErr("");
    try {
      navigate(`/connect/${(await startUpdate(again, game, repos[game.id], lang)).id}`);
    } catch (e) {
      // Toki can't reach this game's code with this account: the developer picks the repository.
      if (e instanceof NoSource) return navigate(updateConnectPath(again, game.id));
      setErr(t(`connect.err.${connectError(e instanceof ApiError ? e.message : "error")}`));
      setBusy("");
    }
  };
  const markDone = async (updates: GameUpdate[], done: boolean) => {
    setBusy("mark");
    setErr("");
    try {
      await onMark(game.id, updates.map((u) => u.topic), done);
    } catch {
      setErr(t("devup.markFailed"));
    }
    setBusy("");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(updateInstructions(again, snippet));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!todo.length) {
    return (
      <li>
        <span className="info">
          <b>{game.title}</b>
          <span className="sub">✓ {t("devup.marked")}</span>
        </span>
        <button type="button" className="btn" disabled={!!busy} onClick={() => markDone(marked, false)}>{t("devup.unmark")}</button>
        {err && <p className="error" role="alert">{err}</p>}
      </li>
    );
  }
  return (
    <li>
      <span className="info">
        <b>{game.title}</b>
        <span className="sub">{t("devup.needs", { list: todo.map((u) => t(updateKeys(u.topic).short as Key)).join(", ") })}</span>
        {running && <span className="sub">{t("devup.running")} <Link to={`/connect/${running.id}`}>{t("connect.open")}</Link></span>}
        {!running && prs.map((job) => (
          <span key={job.id} className="sub">✓ {t("devup.pr")} <a href={job.pr_url!} target="_blank" rel="noopener noreferrer">{t("connect.openPr")} ↗</a></span>
        ))}
        {!running && closed && !failed && <span className="sub">{t("devup.closed")}</span>}
        {!running && failed && <span className="sub">{t("devup.failed")} <Link to={`/connect/${failed.id}`}>{t("connect.open")}</Link></span>}
      </span>
      {!running && (
        <span className="dev-update-buttons">
          {again.length > 0 && connect && (
            <button type="button" className="btn primary" disabled={!!busy} onClick={start}>
              {busy === "start" ? t("connect.starting") : t("devup.connect")}
            </button>
          )}
          {again.length > 0 && (
            <button type="button" className="btn" onClick={copy} aria-live="polite">{copied ? t("saveSupport.copied") : t("devup.copy")}</button>
          )}
          <button type="button" className="btn" disabled={!!busy} onClick={() => markDone(todo, true)} title={t("devup.markHelp")}>
            {t("devup.markDone")}
          </button>
        </span>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </li>
  );
}
