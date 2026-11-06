import { useI18n } from "../lib/i18n";
import { useFavorites } from "../lib/local";
import { useGames } from "../lib/useGames";
import { GameGrid } from "../components/GameCard";

export function Favorites() {
  const { t } = useI18n();
  const { games, error } = useGames();
  const { favs } = useFavorites();
  if (error) return <p className="msg">{t("error")}</p>;
  if (!games) return <p className="msg">{t("loading")}</p>;
  const list = favs.map((s) => games.find((g) => g.slug === s)).filter((g) => !!g);
  return (
    <section>
      <div className="sechead"><h1 className="h">{t("favs.title")}</h1></div>
      {list.length ? <GameGrid games={list as NonNullable<(typeof list)[number]>[]} /> : <p className="msg">{t("favs.empty")}</p>}
      <p className="note">{t("favs.note")}</p>
    </section>
  );
}
