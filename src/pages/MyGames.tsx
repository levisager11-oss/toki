import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { compact, likes, myGameStats, plays } from "../lib/games";
import { Cover } from "../components/Cover";
import { HeartIcon, PlayIcon } from "../components/icons";

export function MyGames() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const { games, error } = useGames();
  const [daily, setDaily] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (profile) myGameStats().then(setDaily).catch(() => {});
  }, [profile]);

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games || !profile) return <p className="msg" aria-busy="true">{t("loading")}</p>;
  const isAdmin = profile.role === "admin";
  const list = isAdmin ? games : games.filter((g) => g.created_by === profile.id);

  return (
    <section>
      <div className="sechead">
        <h1 className="h">{isAdmin ? t("my.allTitle") : t("my.title")}</h1>
        <div className="actions">
          {isAdmin && <Link to="/applications" className="btn">{t("nav.applications")}</Link>}
          <Link to="/feedback/inbox" className="btn">{t("fb.inbox.title")}</Link>
          <Link to="/add" className="btn primary"><span aria-hidden="true">+</span>{t("my.add")}</Link>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="msg">{t("my.empty")}</p>
      ) : (
        <ul className="table">
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
              </div>
              <div className="stats">
                <span title={t("stats.plays", { n: plays(g) })}><PlayIcon size={10} /> {compact(plays(g))}</span>
                <span title={t("stats.likes", { n: likes(g) })}><HeartIcon /> {compact(likes(g))}</span>
                {daily[g.id] && <Spark days={daily[g.id]} label={t("my.plays14")} />}
              </div>
              <Link to={`/edit/${g.slug}`} className="btn">{t("game.edit")}</Link>
            </li>
          ))}
        </ul>
      )}
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
