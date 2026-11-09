import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canManage } from "../lib/feedback";
import { formatScore, leaderboard, removeScore, submitScore, validScore, type ScoreRow } from "../lib/social";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";

export type ScoreEvent = { score: number; best?: number; isNew?: boolean; guest?: boolean };

/**
 * Listens for scores from the game in the frame (toki.score(n) in toki-save.js) and saves them
 * for logged-in players. Only messages from that frame and the game's own site count.
 */
export function useScoreBridge(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, userId: string | undefined) {
  const [last, setLast] = useState<ScoreEvent | null>(null);
  const [version, setVersion] = useState(0);
  const sending = useRef(Promise.resolve());
  const gameId = game?.id;
  const playUrl = game?.play_url;

  useEffect(() => {
    setLast(null);
    if (!gameId || !playUrl) return;
    let origin: string;
    try {
      origin = new URL(playUrl).origin;
    } catch {
      return;
    }
    let alive = true;
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1 || m.type !== "score" || !validScore(m.data)) return;
      const score = m.data;
      if (!userId) return setLast({ score, guest: true });
      // One after another, so the best score is always compared with the latest one.
      sending.current = sending.current.then(() =>
        submitScore(gameId, score).then(
          (r) => {
            if (!alive) return;
            setLast({ score, best: r.best, isNew: r.new });
            if (r.new) setVersion((v) => v + 1);
          },
          () => {},
        ),
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      window.removeEventListener("message", onMessage);
    };
  }, [frame, gameId, playUrl, userId]);

  return { last, version };
}

/** Top 10 of a game, and the player's own place. Shown once the game has sent a score. */
export function Leaderboard({ game, version, last }: { game: Game; version: number; last: ScoreEvent | null }) {
  const { t, lang } = useI18n();
  const { profile, session } = useAuth();
  const location = useLocation();
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [reload, setReload] = useState(0);
  const me = session?.user.id;
  const manager = canManage({ game: { slug: game.slug, title: game.title, created_by: game.created_by } }, profile);

  useEffect(() => {
    let alive = true;
    leaderboard(game.id).then((r) => alive && setRows(r), () => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [game.id, version, reload, me]);

  if (!rows || (rows.length === 0 && !last)) return null;
  const fmt = (n: number) => formatScore(n, game.score_format, lang);
  const top = rows.filter((r) => r.rank <= 10);
  const mine = rows.find((r) => r.user_id === me && r.rank > 10);

  return (
    <section id="scores" className="leaderboard">
      <div className="sechead"><h2>{t("score.title")}</h2></div>
      {last && (
        <p className={`check ${last.isNew ? "good" : ""}`} role="status">
          {last.guest ? (
            <>{t("score.guest", { score: fmt(last.score) })} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link></>
          ) : last.isNew ? t("score.newBest", { score: fmt(last.score) }) : t("score.notBest", { score: fmt(last.score), best: fmt(last.best ?? last.score) })}
        </p>
      )}
      {top.length === 0 ? <p className="msg">{t("score.none")}</p> : (
        <ol className="board">
          {[...top, ...(mine ? [mine] : [])].map((r) => (
            <li key={r.user_id} className={r.user_id === me ? "me" : ""}>
              <span className="rank">{r.rank}</span>
              <Link to={`/u/${r.username}`} className="person"><Avatar person={r} size={24} /><b>@{r.username}</b></Link>
              <b className="score">{fmt(r.score)}</b>
              {manager && r.user_id !== me && (
                <button type="button" className="linkish" onClick={() => removeScore(game.id, r.user_id).then(() => setReload((n) => n + 1), () => {})}>{t("score.remove")}</button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="hint">{t(game.score_order === "low" ? "score.lowBetter" : "score.highBetter")}</p>
    </section>
  );
}
