import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useTitle } from "../lib/useTitle";
import { useI18n } from "../lib/i18n";
import { useAuth } from "../lib/auth";
import { useMediaQuery } from "../lib/useMediaQuery";
import { markPlayed, visitorId } from "../lib/local";
import { findGame, plays, recordPlay } from "../lib/games";
import { useGames } from "../lib/useGames";
import { useSaveBridge } from "../lib/saves";
import { matchIsolation } from "../lib/isolation";
import { GameGrid, Plays } from "../components/GameCard";
import { FavButton } from "../components/FavButton";
import { GameFeedback } from "../components/GameFeedback";
import { GameUpdates } from "../components/GameUpdates";
import { GameChat } from "../components/GameChat";
import { Leaderboard, useScoreBridge } from "../components/Leaderboard";
import { setPlaying } from "../lib/useBadges";
import { TranslateToggle, useTranslate } from "../components/AiBits";
import { GameHelper } from "../components/GameHelper";
import { Screenshots } from "../components/ShotViewer";
import { useFreeAi } from "../lib/assist";
import { CloseIcon, FullscreenIcon } from "../components/icons";
import { ShareButton } from "../components/ShareButton";

const LANDSCAPE_PHONE = "(orientation: landscape) and (pointer: coarse) and (max-height: 600px)";
// A visit counts as a play after this long on the page (the server counts one per browser per day).
const PLAY_AFTER_MS = 10_000;

export function GamePage() {
  const { slug = "" } = useParams();
  const { t, lang } = useI18n();
  const { profile, session, ready: authReady } = useAuth();
  const { games, error } = useGames();
  const frameWrap = useRef<HTMLDivElement>(null);
  const gameFrame = useRef<HTMLIFrameElement>(null);
  const [isFull, setIsFull] = useState(false);
  // iPhones can't put a page element into real fullscreen, so we fill the screen with CSS instead.
  const [pseudoFull, setPseudoFull] = useState(false);
  // Phone turned sideways: the game fills the screen on its own; turning back to portrait leaves.
  const landscapePhone = useMediaQuery(LANDSCAPE_PHONE);
  const fillScreen = pseudoFull || landscapePhone;
  const game = findGame(games, slug);
  const [helper, setHelper] = useState(false);
  const freeAi = useFreeAi();
  const gameId = game?.id;
  const userId = session?.user.id;
  const saves = useSaveBridge(gameFrame, gameId, game?.play_url, userId);
  const scores = useScoreBridge(gameFrame, game, userId);
  // Loads the game again, e.g. to continue from newer progress made on another device.
  const [frameRun, setFrameRun] = useState(0);
  const isolated = game?.needs_isolation === true;

  useEffect(() => {
    if (game) matchIsolation(isolated);
  }, [game, isolated]);

  // Friends see which game is open.
  useEffect(() => {
    setPlaying(gameId ?? null);
    return () => setPlaying(null);
  }, [gameId]);

  useEffect(() => {
    if (!gameId) return;
    const id = setTimeout(() => recordPlay(gameId, visitorId()).catch(() => {}), PLAY_AFTER_MS);
    return () => clearTimeout(id);
  }, [gameId]);

  useEffect(() => {
    if (game) markPlayed(game.slug);
  }, [game]);
  useTitle(game?.title);

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
    // On iPhones a fixed layer over a scrolled page leaves a strip of the page showing, and
    // moving the page itself (e.g. pinning <body> with a negative offset) makes taps inside
    // the game land in the wrong place. So: go to the top of the page, where the game layer
    // and the page line up, block scrolling while the game fills the screen, and go back
    // to where the visitor was afterwards.
    const y = window.scrollY;
    const html = document.documentElement;
    window.scrollTo(0, 0);
    html.classList.add("no-scroll");

    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPseudoFull(false);
    document.addEventListener("keydown", onKey);
    return () => {
      html.classList.remove("no-scroll");
      window.scrollTo(0, y);
      document.removeEventListener("keydown", onKey);
    };
  }, [fillScreen]);

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games || !authReady)
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
        <div className="actions">
          <Link to={`/?q=${encodeURIComponent(slug.replace(/-/g, " "))}`} className="btn primary">{t("game.searchFor", { q: slug.replace(/-/g, " ") })}</Link>
          <Link to="/" className="btn">{t("back")}</Link>
        </div>
      </div>
    );

  // An old address of a renamed game: go to the current one.
  if (game.slug !== slug) return <Navigate to={`/game/${game.slug}`} replace />;

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
          {/* Starts again after logging in or out, so the game gets the right save. */}
          <iframe
            ref={gameFrame}
            key={`${game.play_url}|${userId ?? ""}|${frameRun}`}
            src={game.play_url}
            title={game.title}
            allow={`fullscreen; autoplay; gamepad;${isolated ? " cross-origin-isolated;" : ""} clipboard-write; screen-wake-lock`}
            allowFullScreen
            // On computers, keys go to the game right away (no click into it first), unless
            // the visitor is already somewhere else on the page, e.g. typing in the search.
            onLoad={(e) => {
              const active = document.activeElement;
              if (matchMedia("(pointer: fine)").matches && (!active || active === document.body)) e.currentTarget.focus({ preventScroll: true });
            }}
          />
        </div>
        <div className="player-bar">
          <div className="info">
            <h1>{game.title}</h1>
            <span className="sub">
              {t("game.by")} {game.author ? <Link to={`/u/${game.author.username}`}><b>@{game.author.username}</b></Link> : <b>Toki</b>}
              {game.engine ? ` · ${game.engine}` : ""} · {t(`cat.${game.category}`)}
              {plays(game) > 0 && <> · <Plays game={game} /></>}
            </span>
          </div>
          <div className="actions">
            <FavButton game={game} withLabel />
            <ShareButton path={`/game/${game.slug}`} title={game.title} />
            {canEdit && <Link to={`/edit/${game.slug}`} className="btn">{t("game.edit")}</Link>}
            <button type="button" className="btn primary" onClick={fullscreen}><FullscreenIcon />{t("game.fullscreen")}</button>
          </div>
        </div>
        {freeAi && helper && <GameHelper key={game.id} game={game} onClose={() => setHelper(false)} />}
        {(saves.lost || saves.conflict) && (
          <div className="check warn save-conflict" role="alert">
            <p>{t(saves.lost ? (userId ? "saves.lostAccount" : "saves.lostDevice") : "saves.conflict")}</p>
            <button type="button" className="btn" onClick={() => setFrameRun((n) => n + 1)}>{t(saves.lost ? "saves.loadSaved" : "saves.loadNewer")}</button>
          </div>
        )}
        {saves.status === "account" && !saves.conflict && !saves.lost && <p className="hint saved">✓ {t("saves.account")}</p>}
        {saves.status === "device" && (
          <p className="hint saved">
            {t("saves.device")} <Link to={`/signup?next=/game/${game.slug}`}>{t("saves.signup")}</Link>
          </p>
        )}
        <p className="hint">
          {t("game.notLoading")}{" "}
          <a href={game.play_url} target="_blank" rel="noopener noreferrer">{t("game.openDirect")} ↗</a>
        </p>
        {freeAi && userId && !helper && (
          <p className="hint">
            <button type="button" className="linkish" onClick={() => setHelper(true)} aria-expanded={false}>{t("helper.open")}</button>
          </p>
        )}
      </section>

      {game.screenshots.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("game.screenshots")}</h2></div>
          <Screenshots shots={game.screenshots} title={game.title} />
        </section>
      )}

      {(desc || game.controls) && (
        <section className="about">
          {desc && (
            <div>
              <h2>{t("game.about")}</h2>
              <AboutText gameId={game.id} text={desc} translatable={desc === game.description} />
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

      <Leaderboard game={game} version={scores.version} last={scores.last} />
      <GameUpdates game={game} />
      <GameChat game={game} />
      <GameFeedback game={game} />

      {more.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("game.more")}</h2></div>
          <GameGrid games={more} />
        </section>
      )}
    </>
  );
}

/** The game's description, with "Translate" when it's only in the other language. */
function AboutText({ gameId, text, translatable }: { gameId: string; text: string; translatable: boolean }) {
  const tr = useTranslate("game", gameId, translatable ? text : "");
  return (
    <>
      <p>{tr.texts?.[0] ?? text}</p>
      <TranslateToggle tr={tr} />
    </>
  );
}
