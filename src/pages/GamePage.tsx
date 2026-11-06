import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../lib/useMediaQuery";

const LANDSCAPE_PHONE = "(orientation: landscape) and (pointer: coarse) and (max-height: 600px)";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/auth";
import { markPlayed } from "../lib/local";
import { useGames } from "../lib/useGames";
import { GameGrid } from "../components/GameCard";
import { FavButton } from "../components/FavButton";
import { CloseIcon, FullscreenIcon } from "../components/icons";

export function GamePage() {
  const { slug = "" } = useParams();
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const { games, error } = useGames();
  const frameWrap = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  // iPhones can't put a page element into real fullscreen, so we fill the screen with CSS instead.
  const [pseudoFull, setPseudoFull] = useState(false);
  // Phone turned sideways: the game fills the screen on its own; turning back to portrait leaves.
  const landscapePhone = useMediaQuery(LANDSCAPE_PHONE);
  const fillScreen = pseudoFull || landscapePhone;
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
    const onChange = () => {
      const d = document as Document & { webkitFullscreenElement?: Element };
      setIsFull((d.fullscreenElement ?? d.webkitFullscreenElement) === frameWrap.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  useEffect(() => {
    if (!landscapePhone) setPseudoFull(false);
  }, [landscapePhone]);

  useEffect(() => {
    if (!fillScreen) return;
    document.documentElement.classList.add("no-scroll");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPseudoFull(false);
    document.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("no-scroll");
      document.removeEventListener("keydown", onKey);
    };
  }, [fillScreen]);

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
    const el = frameWrap.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudoFull(true));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else setPseudoFull(true);
  };
  const desc = (lang === "de" && game.description_de) || game.description;
  const canEdit = profile && (profile.role === "admin" || profile.id === game.created_by);
  const more = games.filter((g) => g.id !== game.id).slice(0, 8);

  return (
    <>
      <section className="player">
        <div className={`frame ${isFull ? "is-full" : ""} ${fillScreen ? "pseudo-full" : ""}`} ref={frameWrap}>
          {pseudoFull && !landscapePhone && (
            <button type="button" className="close-full" onClick={() => setPseudoFull(false)} aria-label={t("game.exitFullscreen")}>
              <CloseIcon />
            </button>
          )}
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
