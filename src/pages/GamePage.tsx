import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/auth";
import { markPlayed } from "../lib/local";
import { useGames } from "../lib/useGames";
import { GameGrid } from "../components/GameCard";
import { FavButton } from "../components/FavButton";
import { FullscreenIcon } from "../components/icons";

export function GamePage() {
  const { slug = "" } = useParams();
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const { games, error } = useGames();
  const frameWrap = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  const game = games?.find((g) => g.slug === slug);

  useEffect(() => {
    if (game) {
      markPlayed(game.slug);
      document.title = `${game.title} · Toki`;
    }
    return () => {
      document.title = "Toki";
    };
  }, [game]);

  useEffect(() => {
    const onChange = () => setIsFull(document.fullscreenElement === frameWrap.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games) return <p className="msg">{t("loading")}</p>;
  if (!game)
    return (
      <div className="msg">
        <p>{t("game.notFound")}</p>
        <Link to="/" className="btn">{t("back")}</Link>
      </div>
    );

  const fullscreen = () => {
    const el = frameWrap.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };
  const desc = (lang === "de" && game.description_de) || game.description;
  const canEdit = profile && (profile.role === "admin" || profile.id === game.created_by);
  const more = games.filter((g) => g.id !== game.id).slice(0, 8);

  return (
    <>
      <section className="player">
        <div className={`frame ${isFull ? "is-full" : ""}`} ref={frameWrap}>
          <iframe
            key={game.play_url}
            src={game.play_url}
            title={game.title}
            allow="fullscreen; autoplay; gamepad; cross-origin-isolated; clipboard-write; screen-wake-lock"
            allowFullScreen
          />
        </div>
        <div className="player-bar">
          <div className="info">
            <h1>{game.title}</h1>
            <span className="sub">
              {t("game.by")} <b>{game.author ? `@${game.author.username}` : "Toki"}</b>
              {game.engine ? ` · ${game.engine}` : ""} · {t(`cat.${game.category}`)}
            </span>
          </div>
          <div className="actions">
            <FavButton slug={game.slug} withLabel />
            {canEdit && <Link to={`/edit/${game.slug}`} className="btn">{t("game.edit")}</Link>}
            <button type="button" className="btn primary" onClick={fullscreen}><FullscreenIcon />{t("game.fullscreen")}</button>
          </div>
        </div>
        <p className="hint">
          {t("game.notLoading")}{" "}
          <a href={game.play_url} target="_blank" rel="noopener noreferrer">{t("game.openDirect")} ↗</a>
        </p>
      </section>

      {(desc || game.controls) && (
        <section className="about">
          {desc && (
            <div>
              <h2>{t("game.about")}</h2>
              <p>{desc}</p>
            </div>
          )}
          {game.controls && (
            <div>
              <h2>{t("game.controls")}</h2>
              <p>{game.controls}</p>
            </div>
          )}
        </section>
      )}

      {more.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("game.more")}</h2></div>
          <GameGrid games={more} />
        </section>
      )}
    </>
  );
}
