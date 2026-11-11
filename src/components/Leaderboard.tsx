import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canManage } from "../lib/feedback";
import { formatScore, leaderboard, removeScore, submitScore, validScore, type ScoreRow } from "../lib/social";
import { dailyChanged, formatLeft, msUntilNextDay, msUntilNextWeek, periodLeaderboard, useDaily, useMinuteClock, utcDay } from "../lib/daily";
import type { Game } from "../lib/types";
import { allBoards, boardLabel, MAIN, sentBoard, type Board } from "../lib/boardRules";
import { Avatar } from "./Avatar";
import { ShareButton } from "./ShareButton";

export type ScoreEvent = {
  score: number;
  /** the board it went to: "" for the main one */
  board: string;
  best?: number; isNew?: boolean; weekNew?: boolean; dayNew?: boolean; guest?: boolean;
};

/** What the bridge keeps for each board the game sends to. */
interface Sending {
  best: number | null; // the player's best of all time on the server, once known
  bar: number | null; // what a score must beat to change a list, once known
  barDay: string; // the day (UTC) the bar is from
  waiting: number | null; // the best score of the last moment, not sent yet
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Listens for scores from the game in the frame (toki.score(n) or toki.score(n, "board") in
 * toki-save.js) and saves them for logged-in players. Only messages from that frame and the
 * game's own site count. Scores for a board the game doesn't have on Toki are ignored.
 * To keep database requests few, scores within 1.5 seconds are combined per board (only the best
 * is sent), and a score that can't change any list isn't sent at all: one that doesn't beat the
 * player's best of this week (or of today, on Today's game). That bar starts over every day.
 * boards: the game's boards besides the main one (undefined while loading).
 */
export function useScoreBridge(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, userId: string | undefined, boards?: Board[]) {
  const [last, setLast] = useState<ScoreEvent | null>(null);
  const [version, setVersion] = useState(0);
  const sending = useRef(Promise.resolve());
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
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
    const state = new Map<string, Sending>();
    const unknown = new Set<string>(); // boards the server said the game doesn't have
    const lowOn = (board: string) => (board === MAIN ? lowWins : boardsRef.current?.find((b) => b.id === board)?.score_order === "low");
    const beats = (board: string, a: number, b: number) => (lowOn(board) ? a < b : a > b);
    const send = (board: string) => {
      const s = state.get(board);
      const score = s?.waiting ?? null;
      if (!s || score === null) return;
      s.waiting = null;
      if (s.barDay !== utcDay(new Date())) s.bar = null; // a new day or week: every list starts over
      if (s.bar !== null && !beats(board, score, s.bar)) return setLast({ score, board, best: s.best ?? s.bar, isNew: false });
      // One after another, so the best score is always compared with the latest one.
      sending.current = sending.current.then(() =>
        submitScore(gameId, score, board).then(
          (r) => {
            if (!r) return void unknown.add(board);
            s.best = r.best;
            s.bar = r.bar ?? r.best;
            s.barDay = utcDay(new Date());
            if (r.day_new) dailyChanged(gameId);
            if (!alive) return;
            setLast({ score, board, best: r.best, isNew: r.new, weekNew: r.week_new, dayNew: r.day_new });
            if (r.new || r.week_new || r.day_new) setVersion((v) => v + 1);
          },
          () => {},
        ),
      );
    };
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown; board?: unknown } | null;
      if (!m || m.toki !== 1 || m.type !== "score" || !validScore(m.data)) return;
      const board = sentBoard(m.board);
      const known = boardsRef.current;
      if (board === null || unknown.has(board) || (board !== MAIN && known && !known.some((b) => b.id === board))) return;
      const score = m.data;
      if (!userId) return setLast({ score, board, guest: true });
      let s = state.get(board);
      if (!s) state.set(board, (s = { best: null, bar: null, barDay: "", waiting: null }));
      if (s.waiting === null || beats(board, score, s.waiting)) s.waiting = score;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => send(board), 1500);
    };
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      for (const [board, s] of state) {
        clearTimeout(s.timer);
        send(board); // a score sent right before leaving still counts
      }
      window.removeEventListener("message", onMessage);
    };
  }, [frame, gameId, playUrl, userId, lowWins]);

  return { last, version };
}

type Tab = "all" | "week" | "day";

/**
 * Top 10 of a game, and the player's own place: of all time, this week (since Monday) and,
 * on Today's game, today. Shown once the game has sent a score. A game with more boards than its
 * main one gets a row to pick the board (the main one first); today's list is the main board's.
 */
export function Leaderboard({ game, version, last, boards }: { game: Game; version: number; last: ScoreEvent | null; boards?: Board[] }) {
  const { t, lang } = useI18n();
  const { profile, session } = useAuth();
  const location = useLocation();
  const [rows, setRows] = useState<{ key: string; rows: ScoreRow[] } | null>(null);
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
  const now = useMinuteClock();
  const list = allBoards(game, boards ?? []);
  const many = list.length > 1;
  // The board on show: the main one, until the player picks another or the game sends a score to one.
  const [pickedBoard, setPickedBoard] = useState<{ game: string; board: string } | null>(null);
  useEffect(() => {
    if (last) setPickedBoard({ game: game.id, board: last.board });
  }, [last, game.id]);
  const wanted = pickedBoard?.game === game.id ? pickedBoard.board : MAIN;
  const board = list.find((b) => b.id === wanted) ?? list[0];
  // Today's list is the main board's: on another board, this week's instead.
  const tab: Tab = chosen !== "day" ? chosen : board.id !== MAIN ? "week" : isDaily ? "day" : "all";

  const rowsKey = `${game.id}|${board.id}`;
  useEffect(() => {
    let alive = true;
    leaderboard(game.id, 10, board.id).then((r) => alive && setRows({ key: rowsKey, rows: r }), () => alive && setRows({ key: rowsKey, rows: [] }));
    return () => {
      alive = false;
    };
  }, [game.id, board.id, rowsKey, version, reload, me]);

  const periodKey = `${game.id}|${board.id}|${tab}`;
  useEffect(() => {
    if (tab === "all") return;
    let alive = true;
    periodLeaderboard(game.id, tab, 10, board.id).then(
      (r) => alive && setPeriodRows({ key: periodKey, rows: r }),
      () => alive && setPeriodRows({ key: periodKey, rows: [] }),
    );
    return () => {
      alive = false;
    };
  }, [game.id, board.id, tab, periodKey, version, reload, me]);

  // Hidden until the game has scores (on any board, for games that have more).
  if (!rows || (!many && rows.rows.length === 0 && !last)) return null;
  const fmt = (n: number, format = board.score_format) => formatScore(n, format, lang);
  const lastBoard = last ? list.find((b) => b.id === last.board) : undefined;
  const fmtLast = (n: number) => fmt(n, lastBoard?.score_format ?? game.score_format);
  const label = (b: Board) => boardLabel(b, lang, t("boards.main"));
  const shown = tab === "all" ? (rows.key === rowsKey ? rows.rows : null) : periodRows?.key === periodKey ? periodRows.rows : null;
  const top = (shown ?? []).filter((r) => r.rank <= 10);
  const mine = (shown ?? []).find((r) => r.user_id === me && r.rank > 10);
  const tabs: Tab[] = isDaily && board.id === MAIN ? ["day", "week", "all"] : ["all", "week"];
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
      {many && (
        <div className="chips board-pick" role="group" aria-label={t("boards.pick")}>
          {list.map((b) => (
            <button key={b.id || "main"} type="button" className={b.id === board.id ? "on" : ""} aria-pressed={b.id === board.id} onClick={() => setPickedBoard({ game: game.id, board: b.id })}>
              {label(b)}
            </button>
          ))}
        </div>
      )}
      {last && (
        <p className={`check ${last.isNew ? "good" : ""}`} role="status">
          {many && lastBoard && <b className="board-of">{label(lastBoard)}: </b>}
          {last.guest ? (
            <>{t("score.guest", { score: fmtLast(last.score) })} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link></>
          ) : last.isNew || last.dayNew || last.weekNew ? (
            <>
              {t(last.isNew ? "score.newBest" : last.dayNew ? "daily.newBest" : "week.newBest", { score: fmtLast(last.score) })}{" "}
              <ShareButton className="linkish" path={`/game/${game.slug}#scores`} title={game.title} text={t("score.shareText", { score: fmtLast(last.score), title: game.title })} />
            </>
          ) : t("score.notBest", { score: fmtLast(last.score), best: fmtLast(last.best ?? last.score) })}
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
                    removeScore(game.id, r.user_id, board.id).then(() => setReload((n) => n + 1), () => {});
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
        {t(board.score_order === "low" ? "score.lowBetter" : "score.highBetter")}
        {tab === "week" && <> {t("week.hint", { left: formatLeft(msUntilNextWeek(now), lang) })}</>}
        {tab === "day" && <> {t("daily.hint", { left: formatLeft(msUntilNextDay(now), lang) })}</>}
      </p>
    </section>
  );
}
