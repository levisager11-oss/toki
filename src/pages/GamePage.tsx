import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/auth";
import { useMediaQuery } from "../lib/useMediaQuery";
import { markPlayed, visitorId } from "../lib/local";
import { plays, recordPlay } from "../lib/games";
import { useGames } from "../lib/useGames";
import { GameGrid, Plays } from "../components/GameCard";
import { FavButton } from "../components/FavButton";
import { CloseIcon, FullscreenIcon, ShareIcon } from "../components/icons";

const LANDSCAPE_PHONE = "(orientation: landscape) and (pointer: coarse) and (max-height: 600px)";
// A visit counts as a play after this long on the page (the server counts one per browser per day).
const PLAY_AFTER_MS = 10_000;

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
  const [shared, setShared] = useState(false);
  const gameId = game?.id;

  useEffect(() => {
    if (!gameId) return;
    const id = setTimeout(() => recordPlay(gameId, visitorId()).catch(() => {}), PLAY_AFTER_MS);
    return () => clearTimeout(id);
  }, [gameId]);

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
  if (!games)
    return (
      <section className="player skel" aria-busy="true" aria-label={t("loading")}>
        <div className="frame" />
        <span className="bar big" />
      </section>
    );
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
  const share = async () => {
    const url = `${location.origin}/game/${game.slug}`;
    if (navigator.share) {
      // The share sheet throws when the visitor closes it; nothing to do then.
      await navigator.share({ title: game.title, url }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(url).catch(() => {});
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  };
  const desc = (lang === "de" && game.description_de) || game.description;
  const canEdit = profile && (profile.role === "admin" || profile.id === game.created_by);
  // Same category first, then the most played.
  const more = games
    .filter((g) => g.id !== game.id)
    .sort((a, b) => Number(b.category === game.category) - Number(a.category === game.category) || plays(b) - plays(a))
    .slice(0, 8);

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
              {plays(game) > 0 && <> · <Plays game={game} /></>}
            </span>
          </div>
          <div className="actions">
            <FavButton game={game} withLabel />
            <button type="button" className="btn" onClick={share} aria-live="polite"><ShareIcon />{shared ? t("game.copied") : t("game.share")}</button>
            {canEdit && <Link to={`/edit/${game.slug}`} className="btn">{t("game.edit")}</Link>}
            <button type="button" className="btn primary" onClick={fullscreen}><FullscreenIcon />{t("game.fullscreen")}</button>
          </div>
        </div>
        <p className="hint">
          {t("game.notLoading")}{" "}
          <a href={game.play_url} target="_blank" rel="noopener noreferrer">{t("game.openDirect")} ↗</a>
        </p>
      </section>

      {game.screenshots.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("game.screenshots")}</h2></div>
          <div className="shots">
            {game.screenshots.map((src, n) => (
              <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                <img src={src} alt={t("game.screenshotN", { n: n + 1, title: game.title })} loading="lazy" decoding="async" />
              </a>
            ))}
          </div>
        </section>
      )}

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
