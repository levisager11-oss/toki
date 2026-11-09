import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { countActive } from "../lib/feedback";
import type { Game } from "../lib/types";

/** The game page's way into its feedback board. */
export function GameFeedback({ game }: { game: Game }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const board = `/game/${game.slug}/feedback`;

  useEffect(() => {
    let alive = true;
    countActive(game.id).then((n) => alive && setOpen(n)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [game.id]);

  return (
    <section className="fb-teaser" aria-labelledby="fb-teaser-h">
      <div>
        <h2 id="fb-teaser-h">{t("nav.feedback")}</h2>
        <p>
          {t("fb.section.lead", { title: game.title })}
          {open ? <> <Link to={board}>{t("fb.section.open", { n: open })}</Link></> : null}
        </p>
      </div>
      <div className="actions">
        <Link to={`${board}?new=bug`} className="btn">{t("fb.reportBug")}</Link>
        <Link to={`${board}?new=idea`} className="btn">{t("fb.suggest")}</Link>
        <Link to={board} className="linkish">{t("fb.section.see")}</Link>
      </div>
    </section>
  );
}
