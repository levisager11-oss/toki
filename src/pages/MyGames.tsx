import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { compact, likes, myGameStats, plays } from "../lib/games";
import { Cover } from "../components/Cover";
import { useAiStatus } from "../lib/assist";
import { ClockIcon, HeartIcon, PlayIcon } from "../components/icons";
import { useTitle } from "../lib/useTitle";
import { UploadKeys } from "../components/UploadKeys";
import { useHosting } from "../lib/hosting";
import { isHostedUrl } from "../lib/hostingRules";
import { MultiplayerSetup } from "../components/SaveSupport";
import { DevUpdates } from "../components/DevUpdates";
import { formatDuration } from "../lib/analytics";

export function MyGames() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const { games, error } = useGames();
  const ai = useAiStatus();
  const hosting = useHosting();
  const [daily, setDaily] = useState<Record<string, { plays: number[]; seconds: number[] }>>({});
  useTitle(profile?.role === "admin" ? t("my.allTitle") : t("my.title"));

  useEffect(() => {
    if (profile) myGameStats().then(setDaily).catch(() => {});
  }, [profile]);

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games || !profile) return <p className="msg" aria-busy="true">{t("loading")}</p>;
  const isAdmin = profile.role === "admin";
  const list = isAdmin ? games : games.filter((g) => g.created_by === profile.id);
  // The last 30 days over all listed games.
  const month = list.reduce(
    (a, g) => {
      const d = daily[g.id];
      if (!d) return a;
      d.plays.forEach((n, i) => (a.plays[i] += n));
      a.seconds += d.seconds.reduce((x, y) => x + y, 0);
      return a;
    },
    { plays: Array(30).fill(0) as number[], seconds: 0 },
  );
  const monthPlays = month.plays.reduce((a, b) => a + b, 0);
  const allLikes = list.reduce((a, g) => a + likes(g), 0);

  return (
    <section>
      <div className="sechead">
        <h1 className="h">{isAdmin ? t("my.allTitle") : t("my.title")}</h1>
        <div className="actions">
          {isAdmin && <Link to="/applications" className="btn">{t("nav.applications")}</Link>}
          <Link to="/feedback/inbox" className="btn">{t("fb.inbox.title")}</Link>
          {(ai.strong || ai.free) && <Link to="/connect" className="btn">{t("nav.connect")}</Link>}
          <Link to="/add" className="btn primary"><span aria-hidden="true">+</span>{t("my.add")}</Link>
        </div>
      </div>
      {list.length > 0 && Object.keys(daily).length > 0 && (
        <div className="stat-tiles my-overview">
          <div className="tile">
            <span className="label">{t("my.plays30")}</span>
            <b>{compact(monthPlays)}</b>
            <Spark days={month.plays} label={t("my.plays30")} />
          </div>
          <div className="tile"><span className="label">{t("my.time30")}</span><b>{formatDuration(month.seconds, lang)}</b></div>
          <div className="tile"><span className="label">{t("an.likes")}</span><b>{compact(allLikes)}</b></div>
        </div>
      )}
      {list.length === 0 ? (
        <p className="msg">{t("my.empty")}</p>
      ) : (
        <ul className="table my-list">
          {list.map((g) => (
            <li key={g.id}>
              <Cover slug={g.slug} cover={g.cover} image={g.thumbnail_url} />
              <div className="info">
                <Link to={`/game/${g.slug}`} className="title">{g.title}</Link>
                <span className="sub">
                  {g.author ? `@${g.author.username}` : "Toki"} · {t(`cat.${g.category}`)}
                  {g.featured ? ` · ★ ${t("home.featured")}` : ""}
                </span>
                <span className="sub url">{g.play_url}</span>
                <span className="sub my-links">
                  <Link to={`/game/${g.slug}/updates?new=1`}>{t("rel.new")}</Link>
                  {" · "}
                  <Link to={`/game/${g.slug}/feedback`}>{t("nav.feedback")}</Link>
                  {" · "}
                  <Link to={`/game/${g.slug}/stats`}>{t("an.title")}</Link>
                  {hosting?.enabled && hosting.domain && !isHostedUrl(g.play_url, hosting.domain) && (
                    <>
                      {" · "}
                      <Link to={`/edit/${g.slug}#move`}>{t("move.button")}</Link>
                    </>
                  )}
                </span>
              </div>
              <div className="stats">
                <span title={t("stats.plays", { n: plays(g) })}><PlayIcon size={10} /> {compact(plays(g))}</span>
                <span title={t("stats.likes", { n: likes(g) })}><HeartIcon /> {compact(likes(g))}</span>
                {daily[g.id] && <span title={t("my.time30")}><ClockIcon /> {formatDuration(daily[g.id].seconds.reduce((a, b) => a + b, 0), lang)}</span>}
                {daily[g.id] && <Spark days={daily[g.id].plays.slice(-14)} label={t("my.plays14")} />}
              </div>
              <Link to={`/edit/${g.slug}`} className="btn">{t("game.edit")}</Link>
            </li>
          ))}
        </ul>
      )}
      {/* Only the developer's own games, also for admins: the others are their developers' to update. */}
      <DevUpdates games={list.filter((g) => g.created_by === profile.id)} />
      {list.length > 0 && <MultiplayerSetup id="toki-features" open={location.hash === "#toki-features"} />}
      {hosting?.enabled && <UploadKeys />}
    </section>
  );
}

/** Tiny bar chart of plays per day. */
function Spark({ days, label }: { days: number[]; label: string }) {
  const max = Math.max(1, ...days);
  const total = days.reduce((a, b) => a + b, 0);
  return (
    <span className="spark" role="img" aria-label={`${label}: ${total}`} title={`${label}: ${total}`}>
      {days.map((d, i) => (
        <i key={i} style={{ height: `${Math.max(d ? 15 : 4, (d / max) * 100)}%` }} className={d ? "" : "zero"} />
      ))}
    </span>
  );
}
