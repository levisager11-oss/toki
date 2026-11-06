import { useFavorites } from "../lib/local";
import { useI18n } from "../lib/i18n";
import { compact, likes } from "../lib/games";
import type { Game } from "../lib/types";
import { HeartIcon } from "./icons";

// The heart saves a game to Favorites and counts as a public like.
export function FavButton({ game, withLabel }: { game: Game; withLabel?: boolean }) {
  const { isFav, toggle } = useFavorites();
  const { t } = useI18n();
  const on = isFav(game.slug);
  const label = on ? t("fav.remove") : t("fav.add");
  const n = likes(game);
  return (
    <button type="button" className={withLabel ? "btn fav-btn" : "fav"} aria-pressed={on} aria-label={`${label} (${t("stats.likes", { n })})`} title={label} onClick={() => toggle(game)}>
      <HeartIcon />
      {withLabel && <span>{on ? t("fav.saved") : t("fav.save")}</span>}
      {n > 0 && <span className="count" aria-hidden="true">{compact(n)}</span>}
    </button>
  );
}
