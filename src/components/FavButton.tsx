import { useFavorites } from "../lib/local";
import { useI18n } from "../lib/i18n";
import { HeartIcon } from "./icons";

export function FavButton({ slug, withLabel }: { slug: string; withLabel?: boolean }) {
  const { isFav, toggle } = useFavorites();
  const { t } = useI18n();
  const on = isFav(slug);
  const label = on ? t("fav.remove") : t("fav.add");
  return (
    <button type="button" className={withLabel ? "btn fav-btn" : "fav"} aria-pressed={on} aria-label={label} title={label} onClick={() => toggle(slug)}>
      <HeartIcon />
      {withLabel && <span>{label}</span>}
    </button>
  );
}
