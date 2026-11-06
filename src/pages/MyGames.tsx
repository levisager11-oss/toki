import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { Cover } from "../components/Cover";

export function MyGames() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const { games, error } = useGames();
  if (error) return <p className="msg">{t("error")}</p>;
  if (!games || !profile) return <p className="msg">{t("loading")}</p>;
  const isAdmin = profile.role === "admin";
  const list = isAdmin ? games : games.filter((g) => g.created_by === profile.id);

  return (
    <section>
      <div className="sechead">
        <h1 className="h">{isAdmin ? t("my.allTitle") : t("my.title")}</h1>
        <Link to="/add" className="btn primary"><span aria-hidden="true">+</span>{t("my.add")}</Link>
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
              <Link to={`/edit/${g.slug}`} className="btn">{t("game.edit")}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
