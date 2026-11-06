import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useRecent } from "../lib/local";
import { useGames } from "../lib/useGames";
import { Cover } from "../components/Cover";
import { GameGrid, RecentItem } from "../components/GameCard";
import { PlayIcon } from "../components/icons";
import type { Category } from "../lib/types";

export function Home() {
  const { t, lang } = useI18n();
  const { games, error } = useGames();
  const recentSlugs = useRecent();
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const [cat, setCat] = useState<Category | "all">("all");

  const featured = useMemo(() => games?.find((g) => g.featured) ?? games?.[0], [games]);
  const recent = useMemo(
    () => (games ? recentSlugs.map((s) => games.find((g) => g.slug === s)).filter((g) => !!g).slice(0, 6) : []),
    [games, recentSlugs],
  );
  const cats = useMemo(() => [...new Set((games ?? []).map((g) => g.category))].sort(), [games]);
  const shown = useMemo(
    () =>
      (games ?? []).filter(
        (g) =>
          (cat === "all" || g.category === cat) &&
          (!q || g.title.toLowerCase().includes(q) || g.author?.username.includes(q) || t(`cat.${g.category}`).toLowerCase().includes(q)),
      ),
    [games, cat, q, t],
  );

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games) return <p className="msg">{t("loading")}</p>;
  if (!games.length) return <p className="msg">{t("home.empty")}</p>;

  const desc = (g: typeof featured) => (g ? (lang === "de" && g.description_de) || g.description : "");

  return (
    <>
      {!q && featured && (
        <section className="feature">
          <Cover slug={featured.slug} cover={featured.cover} image={featured.thumbnail_url} wide alt={featured.title} />
          <div className="txt">
            <span className="label">{t("home.featured")}</span>
            <h1>{featured.title}</h1>
            {desc(featured) && <p>{desc(featured)}</p>}
            <span className="meta">
              <b>{featured.author ? `@${featured.author.username}` : "Toki"}</b>
              {featured.engine ? ` · ${featured.engine}` : ""} · {t(`cat.${featured.category}`)}
            </span>
            <div className="actions">
              <Link to={`/game/${featured.slug}`} className="btn primary"><PlayIcon />{t("game.play")}</Link>
            </div>
          </div>
        </section>
      )}

      {!q && recent.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("home.recent")}</h2></div>
          <div className="recent">
            {recent.map((g) => <RecentItem key={g!.id} game={g!} />)}
          </div>
        </section>
      )}

      <section id="all">
        <div className="sechead">
          <h2>{q ? t("home.searchResults", { q: params.get("q") ?? "" }) : t("home.all")}</h2>
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
