import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { listReleases, type Release } from "../lib/releases";
import type { Game } from "../lib/types";
import { Notes } from "./ReleaseCard";

/** "What's new" on a game's page: its latest update. The developer is invited to post the first one. */
export function GameUpdates({ game }: { game: Game }) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [latest, setLatest] = useState<Release | null | undefined>(undefined);
  const page = `/game/${game.slug}/updates`;
  const manager = !!profile && (profile.role === "admin" || profile.id === game.created_by);

  useEffect(() => {
    let alive = true;
    listReleases(game.id, 1)
      .then(([r]) => alive && setLatest(r ?? null))
      .catch(() => alive && setLatest(null));
    return () => {
      alive = false;
    };
  }, [game.id]);

  if (latest === undefined) return null;
  if (latest === null)
    return manager ? (
      <section className="fb-teaser rel-teaser">
        <div>
          <h2>{t("rel.whatsNew")}</h2>
          <p>{t("rel.firstPrompt")}</p>
        </div>
        <div className="actions"><Link to={`${page}?new=1`} className="btn">{t("rel.new")}</Link></div>
      </section>
    ) : null;

  return (
    <section className="rel-teaser rel" aria-labelledby="rel-teaser-h">
      <header className="rel-head">
        <h2 id="rel-teaser-h">{t("rel.whatsNew")}</h2>
        <span className="ver">{latest.version}</span>
        <time dateTime={latest.published_at}>{ago(latest.published_at, lang)}</time>
      </header>
      {latest.title && <h3>{latest.title}</h3>}
      <Notes notes={latest.notes} className="clamp" />
      <div className="actions">
        <Link to={`${page}#r-${latest.id}`} className="btn">{t("rel.all")}</Link>
        {latest.fixed.length > 0 && <span className="sub">✓ {t("rel.fixedCount", { n: latest.fixed.length })}</span>}
        {manager && <Link to={`${page}?new=1`} className="linkish">{t("rel.new")}</Link>}
      </div>
    </section>
  );
}
