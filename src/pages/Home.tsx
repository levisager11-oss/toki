import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useRecent } from "../lib/local";
import { useGames } from "../lib/useGames";
import { matches, plays } from "../lib/games";
import { Cover } from "../components/Cover";
import { GameGrid, GridSkeleton, Plays, RecentItem } from "../components/GameCard";
import { PlayIcon } from "../components/icons";
import type { Category, Game } from "../lib/types";

const ROTATE_MS = 8000;
const MAX_SLIDES = 4;

export function Home() {
  const { t } = useI18n();
  const { games, error } = useGames();
  const recentSlugs = useRecent();
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const [cat, setCat] = useState<Category | "all">("all");

  // The admin's featured game first, then the most played ones.
  const slides = useMemo(() => {
    if (!games?.length) return [];
    const rest = games.filter((g) => !g.featured).sort((a, b) => plays(b) - plays(a));
    return [...games.filter((g) => g.featured), ...rest].slice(0, MAX_SLIDES);
  }, [games]);
  const recent = useMemo(
    () => (games ? recentSlugs.map((s) => games.find((g) => g.slug === s)).filter((g): g is Game => !!g).slice(0, 6) : []),
    [games, recentSlugs],
  );
  const cats = useMemo(() => [...new Set((games ?? []).map((g) => g.category))].sort(), [games]);
  const shown = useMemo(
    () => (games ?? []).filter((g) => (cat === "all" || g.category === cat) && matches(g, q, t(`cat.${g.category}`))),
    [games, cat, q, t],
  );

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games)
    return (
      <>
        <section className="feature skel" aria-busy="true" aria-label={t("loading")}>
          <div className="cover" />
          <div className="txt"><span className="bar" style={{ width: "30%" }} /><span className="bar big" /><span className="bar" style={{ width: "80%" }} /></div>
        </section>
        <section><GridSkeleton /></section>
      </>
    );
  if (!games.length) return <p className="msg">{t("home.empty")}</p>;

  return (
    <>
      {!q && slides.length > 0 && <Featured slides={slides} />}

      {!q && recent.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("home.recent")}</h2></div>
          <div className="recent">
            {recent.map((g) => <RecentItem key={g.id} game={g} />)}
          </div>
        </section>
      )}

      <section id="all">
        <div className="sechead">
          <h2>{q ? t("home.searchResults", { q }) : t("home.all")}</h2>
          {cats.length > 1 && (
            <div className="chips" role="group">
              <button type="button" className={cat === "all" ? "on" : ""} aria-pressed={cat === "all"} onClick={() => setCat("all")}>{t("home.allCategories")}</button>
              {cats.map((c) => (
                <button type="button" key={c} className={cat === c ? "on" : ""} aria-pressed={cat === c} onClick={() => setCat(c)}>{t(`cat.${c}`)}</button>
              ))}
            </div>
          )}
        </div>
        {shown.length ? <GameGrid games={shown} /> : <p className="msg">{t("home.noMatch")}</p>}
      </section>
    </>
  );
}

function Featured({ slides }: { slides: Game[] }) {
  const { t, lang } = useI18n();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const game = slides[i % slides.length];

  useEffect(() => {
    if (slides.length < 2 || paused || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setTimeout(() => setI((n) => (n + 1) % slides.length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [i, paused, slides.length]);

  const desc = (lang === "de" && game.description_de) || game.description;
  return (
    <section
      className="feature"
      aria-roledescription="carousel"
      aria-label={t("home.featured")}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Link to={`/game/${game.slug}`} className="feature-cover" tabIndex={-1} aria-hidden="true">
        <Cover key={game.id} slug={game.slug} cover={game.cover} image={game.thumbnail_url} wide fit animate="always" />
      </Link>
      <div className="txt" key={game.id}>
        <span className="label">{game.featured ? t("home.featured") : t("home.popular")}</span>
        <h1>{game.title}</h1>
        {desc && <p>{desc}</p>}
        <span className="meta">
          <b>{game.author ? `@${game.author.username}` : "Toki"}</b>
          {game.engine ? ` · ${game.engine}` : ""} · {t(`cat.${game.category}`)}
          {plays(game) > 0 && <> · <Plays game={game} /></>}
        </span>
        <div className="actions">
          <Link to={`/game/${game.slug}`} className="btn primary"><PlayIcon />{t("game.play")}</Link>
          {slides.length > 1 && (
            <div className="dots" role="group" aria-label={t("home.pickFeatured")}>
              {slides.map((s, n) => (
                <button type="button" key={s.id} className={n === i ? "on" : ""} aria-pressed={n === i} aria-label={s.title} onClick={() => setI(n)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
