import { Link } from "react-router-dom";
import type { Game } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { Cover } from "./Cover";
import { FavButton } from "./FavButton";

export function GameCard({ game }: { game: Game }) {
  const { t } = useI18n();
  return (
    <article className="card">
      <Link to={`/game/${game.slug}`} className="thumb">
        <Cover slug={game.slug} cover={game.cover} image={game.thumbnail_url} />
        <span className="tag">{t(`cat.${game.category}`)}</span>
      </Link>
      <div className="row">
        <div className="info">
          <Link to={`/game/${game.slug}`} className="title">{game.title}</Link>
          <span className="sub">
            {game.author ? `@${game.author.username}` : "Toki"}
            {game.engine ? ` · ${game.engine}` : ""}
          </span>
        </div>
        <FavButton slug={game.slug} />
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
      <Cover slug={game.slug} cover={game.cover} image={game.thumbnail_url} />
      <span>
        <b>{game.title}</b>
        <span className="sub">{game.author ? `@${game.author.username}` : "Toki"}</span>
      </span>
    </Link>
  );
}
