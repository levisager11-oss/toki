import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canManage } from "../lib/feedback";
import { formatScore, leaderboard, removeScore, submitScore, validScore, type ScoreRow } from "../lib/social";
import { dailyChanged, formatLeft, msUntilNextDay, msUntilNextWeek, periodLeaderboard, useDaily, useMinuteClock, utcDay } from "../lib/daily";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { ShareButton } from "./ShareButton";

export type ScoreEvent = { score: number; best?: number; isNew?: boolean; weekNew?: boolean; dayNew?: boolean; guest?: boolean };

/**
 * Listens for scores from the game in the frame (toki.score(n) in toki-save.js) and saves them
 * for logged-in players. Only messages from that frame and the game's own site count.
 * To keep database requests few, scores within 1.5 seconds are combined (only the best is
 * sent), and a score that can't change any list isn't sent at all: one that doesn't beat the
 * player's best of this week (or of today, on Today's game). That bar starts over every day.
 */
export function useScoreBridge(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, userId: string | undefined) {
  const [last, setLast] = useState<ScoreEvent | null>(null);
  const [version, setVersion] = useState(0);
  const sending = useRef(Promise.resolve());
  const gameId = game?.id;
  const playUrl = game?.play_url;
  const lowWins = game?.score_order === "low";

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
    let best: number | null = null; // the player's best of all time on the server, once known
    let bar: number | null = null; // what a score must beat to change a list, once known
    let barDay = ""; // the day (UTC) the bar is from
    let waiting: number | null = null; // the best score of the last moment, not sent yet
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beats = (a: number, b: number) => (lowWins ? a < b : a > b);
    const send = () => {
      const score = waiting;
      waiting = null;
      if (score === null) return;
      if (barDay !== utcDay(new Date())) bar = null; // a new day or week: every list starts over
      if (bar !== null && !beats(score, bar)) return setLast({ score, best: best ?? bar, isNew: false });
      // One after another, so the best score is always compared with the latest one.
      sending.current = sending.current.then(() =>
        submitScore(gameId, score).then(
          (r) => {
            best = r.best;
            bar = r.bar ?? r.best;
            barDay = utcDay(new Date());
            if (r.day_new) dailyChanged(gameId);
            if (!alive) return;
            setLast({ score, best: r.best, isNew: r.new, weekNew: r.week_new, dayNew: r.day_new });
            if (r.new || r.week_new || r.day_new) setVersion((v) => v + 1);
          },
          () => {},
        ),
      );
    };
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1 || m.type !== "score" || !validScore(m.data)) return;
      const score = m.data;
      if (!userId) return setLast({ score, guest: true });
      if (waiting === null || beats(score, waiting)) waiting = score;
      clearTimeout(timer);
      timer = setTimeout(send, 1500);
    };
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      clearTimeout(timer);
      send(); // a score sent right before leaving still counts
      window.removeEventListener("message", onMessage);
    };
  }, [frame, gameId, playUrl, userId, lowWins]);

  return { last, version };
}

type Tab = "all" | "week" | "day";

/**
 * Top 10 of a game, and the player's own place: of all time, this week (since Monday) and,
 * on Today's game, today. Shown once the game has sent a score.
 */
export function Leaderboard({ game, version, last }: { game: Game; version: number; last: ScoreEvent | null }) {
  const { t, lang } = useI18n();
  const { profile, session } = useAuth();
  const location = useLocation();
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [periodRows, setPeriodRows] = useState<{ key: string; rows: ScoreRow[] } | null>(null);
  const [reload, setReload] = useState(0);
  // Removing a score takes two taps: the first asks "Sure?".
  const [removing, setRemoving] = useState<string | null>(null);
  const me = session?.user.id;
  const manager = canManage({ game: { slug: game.slug, title: game.title, created_by: game.created_by } }, profile);
  const daily = useDaily(me);
  const isDaily = !!daily && daily.game_id === game.id;
  // On Today's game, today's list comes first, until the player picks another.
  const [picked, setPicked] = useState<{ game: string; tab: Tab } | null>(null);
  const chosen: Tab = picked?.game === game.id ? picked.tab : isDaily ? "day" : "all";
  const tab: Tab = chosen === "day" && !isDaily ? "all" : chosen;
  const now = useMinuteClock();

  useEffect(() => {
    let alive = true;
    leaderboard(game.id).then((r) => alive && setRows(r), () => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [game.id, version, reload, me]);

  const periodKey = `${game.id}|${tab}`;
  useEffect(() => {
    if (tab === "all") return;
    let alive = true;
    periodLeaderboard(game.id, tab).then(
      (r) => alive && setPeriodRows({ key: periodKey, rows: r }),
      () => alive && setPeriodRows({ key: periodKey, rows: [] }),
    );
    return () => {
      alive = false;
    };
  }, [game.id, tab, periodKey, version, reload, me]);

  if (!rows || (rows.length === 0 && !last)) return null;
  const fmt = (n: number) => formatScore(n, game.score_format, lang);
  const shown = tab === "all" ? rows : periodRows?.key === periodKey ? periodRows.rows : null;
  const top = (shown ?? []).filter((r) => r.rank <= 10);
  const mine = (shown ?? []).find((r) => r.user_id === me && r.rank > 10);
  const tabs: Tab[] = isDaily ? ["day", "week", "all"] : ["all", "week"];
  const tabLabel = (v: Tab) => (v === "day" ? t("daily.tab") : v === "week" ? t("week.tab") : t("week.allTime"));
  const empty = tab === "day" ? t("daily.none") : tab === "week" ? t("week.none") : t("score.none");

  return (
    <section id="scores" className="leaderboard">
      <div className="sechead">
        <h2>{t("score.title")}</h2>
        <div className="seg board-tabs" role="radiogroup" aria-label={t("week.show")}>
          {tabs.map((v) => (
            <label key={v} className={tab === v ? "on" : ""}>
              <input type="radio" name={`board-${game.id}`} checked={tab === v} onChange={() => setPicked({ game: game.id, tab: v })} />
              {tabLabel(v)}
            </label>
          ))}
        </div>
      </div>
      {last && (
        <p className={`check ${last.isNew ? "good" : ""}`} role="status">
          {last.guest ? (
            <>{t("score.guest", { score: fmt(last.score) })} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link></>
          ) : last.isNew || last.dayNew || last.weekNew ? (
            <>
              {t(last.isNew ? "score.newBest" : last.dayNew ? "daily.newBest" : "week.newBest", { score: fmt(last.score) })}{" "}
              <ShareButton className="linkish" path={`/game/${game.slug}#scores`} title={game.title} text={t("score.shareText", { score: fmt(last.score), title: game.title })} />
            </>
          ) : t("score.notBest", { score: fmt(last.score), best: fmt(last.best ?? last.score) })}
        </p>
      )}
      {!shown ? <p className="msg" aria-busy="true">{t("loading")}</p> : top.length === 0 ? <p className="msg">{empty}</p> : (
        <ol className="board">
          {[...top, ...(mine ? [mine] : [])].map((r) => (
            <li key={r.user_id} className={r.user_id === me ? "me" : ""}>
              <span className="rank">{r.rank}</span>
              <Link to={`/u/${r.username}`} className="person"><Avatar person={r} size={24} /><b>@{r.username}</b></Link>
              <b className="score">{fmt(r.score)}</b>
              {manager && r.user_id !== me && (
                <button
                  type="button"
                  className={`linkish ${removing === r.user_id ? "danger-text" : ""}`}
                  onClick={() => {
                    if (removing !== r.user_id) return setRemoving(r.user_id);
                    setRemoving(null);
                    removeScore(game.id, r.user_id).then(() => setReload((n) => n + 1), () => {});
                  }}
                  onBlur={() => setRemoving((cur) => (cur === r.user_id ? null : cur))}
                >
                  {removing === r.user_id ? t("score.removeSure") : t("score.remove")}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="hint">
        {t(game.score_order === "low" ? "score.lowBetter" : "score.highBetter")}
        {tab === "week" && <> {t("week.hint", { left: formatLeft(msUntilNextWeek(now), lang) })}</>}
        {tab === "day" && <> {t("daily.hint", { left: formatLeft(msUntilNextDay(now), lang) })}</>}
      </p>
    </section>
  );
}
