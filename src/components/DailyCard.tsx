import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { currentStreak, formatLeft, msUntilNextDay, playedToday, useDaily, useMinuteClock } from "../lib/daily";
import { formatScore } from "../lib/social";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { Cover } from "./Cover";
import { PlayIcon } from "./icons";

/**
 * "Today's game" at the top of the home page: one game a day for everyone, with its own list
 * of today's scores (top 3 and the player's place), the time until the next game, and the
 * player's streak of days in a row.
 */
export function DailyCard({ games }: { games: Game[] }) {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  const me = session?.user.id;
  const daily = useDaily(me);
  const now = useMinuteClock();

  const game = daily ? games.find((g) => g.id === daily.game_id) : undefined;
  if (!daily || !game) return null;
  const fmt = (n: number) => formatScore(n, game.score_format, lang);
  const top = daily.top.filter((r) => r.rank <= 3);
  const mine = me ? daily.top.find((r) => r.user_id === me) : undefined;
  const streak = currentStreak(daily.streak, daily.day);
  const done = playedToday(daily.streak, daily.day);
  const path = `/game/${game.slug}`;

  return (
    <section className="daily" aria-labelledby="daily-h">
      <Link to={path} className="daily-cover" tabIndex={-1} aria-hidden="true">
        <Cover slug={game.slug} cover={game.cover} image={game.banner_url || game.thumbnail_url} wide eager />
      </Link>
      <div className="daily-txt">
        <div className="daily-head">
          <span className="label">{t("daily.label")}</span>
          <span className="sub">{t("daily.left", { left: formatLeft(msUntilNextDay(now), lang) })}</span>
        </div>
        <h2 id="daily-h"><Link to={path}>{game.title}</Link></h2>
        {me && (
          <p className="daily-streak">
            {streak > 0 ? (
              <>
                <span className={`streak ${done ? "on" : ""}`}>{t("daily.streak", { n: streak })}</span>
                <span className="sub">{done ? t("daily.streakDone") : t("daily.streakKeep")}</span>
              </>
            ) : (
              <span className="sub">{t("daily.streakStart")}</span>
            )}
          </p>
        )}
        <div className="daily-board">
          <h3 className="label">{t("daily.top")}</h3>
          {top.length ? (
            <ol className="board compact">
              {top.map((r) => (
                <li key={r.user_id} className={r.user_id === me ? "me" : ""}>
                  <span className="rank">{r.rank}</span>
                  <Link to={`/u/${r.username}`} className="person"><Avatar person={r} size={22} /><b>@{r.username}</b></Link>
                  <b className="score">{fmt(r.score)}</b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="sub">{t("daily.none")}</p>
          )}
          {!me ? (
            <p className="sub">
              {t("daily.guest")} <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link>
            </p>
          ) : mine ? (
            <p className="sub">{t("daily.you", { rank: mine.rank, n: daily.players, score: fmt(mine.score) })}</p>
          ) : (
            top.length > 0 && <p className="sub">{t("daily.notYet")}</p>
          )}
        </div>
        <div className="actions">
          <Link to={path} className="btn primary"><PlayIcon />{t("game.play")}</Link>
        </div>
      </div>
    </section>
  );
}
