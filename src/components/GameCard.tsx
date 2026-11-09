import { Link } from "react-router-dom";
import type { Game } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { compact, plays } from "../lib/games";
import { Cover } from "./Cover";
import { FavButton } from "./FavButton";
import { PlayIcon } from "./icons";
import { useRecentlyUpdated } from "../lib/releases";

const by = (g: Game) => (g.author ? `@${g.author.username}` : "Toki");

const NEW_FOR_MS = 14 * 24 * 3600_000;
/** Added in the last two weeks. */
export const isNew = (g: Game, now = Date.now()) => !!g.created_at && now - Date.parse(g.created_at) < NEW_FOR_MS;

/** Play count with a small play icon; nothing while a game has no plays yet. */
export function Plays({ game }: { game: Game }) {
  const { t } = useI18n();
  const n = plays(game);
  if (!n) return null;
  return (
    <span className="plays" title={t("stats.plays", { n })}>
      <PlayIcon size={10} />
      <span aria-hidden="true">{compact(n)}</span>
      <span className="sr-only">{t("stats.plays", { n })}</span>
    </span>
  );
}

export function GameCard({ game }: { game: Game }) {
  const { t } = useI18n();
  const updated = useRecentlyUpdated().has(game.id);
  return (
    <article className="card">
      <Link to={`/game/${game.slug}`} className="thumb" tabIndex={-1} aria-hidden="true">
        <Cover slug={game.slug} cover={game.cover} image={game.thumbnail_url} animate="hover" />
        <span className="tag">{t(`cat.${game.category}`)}</span>
        {isNew(game) ? <span className="tag new">{t("game.new")}</span> : updated && <span className="tag new">{t("game.updated")}</span>}
      </Link>
      <div className="row">
        <div className="info">
          <Link to={`/game/${game.slug}`} className="title">{game.title}</Link>
          <span className="sub">
            {game.author ? <Link to={`/u/${game.author.username}`} className="author">@{game.author.username}</Link> : "Toki"}
            {game.engine ? ` · ${game.engine}` : ""}
          </span>
          <Plays game={game} />
        </div>
        <FavButton game={game} />
      </div>
    </article>
  );
}

export function GameGrid({ games }: { games: Game[] }) {
  return (
    <div className="grid">
      {games.map((g) => (
        <GameCard key={g.id} game={g} />
      ))}
    </div>
  );
}

export function RecentItem({ game }: { game: Game }) {
  return (
    <Link to={`/game/${game.slug}`} className="ritem">
      <Cover slug={game.slug} cover={game.cover} image={game.thumbnail_url} animate="hover" />
      <span>
        <b>{game.title}</b>
        <span className="sub">{by(game)}</span>
      </span>
    </Link>
  );
}

/** Grey placeholder cards while the games list loads. */
export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="card skel" key={i}>
          <div className="thumb"><div className="cover" /></div>
          <div className="info">
            <span className="bar" style={{ width: "70%" }} />
            <span className="bar" style={{ width: "40%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
