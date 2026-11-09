import { useI18n } from "../lib/i18n";
import type { Game } from "../lib/types";

/** "Waiting for review", "Declined" or "New link waiting for review"; nothing for a live game. */
export function GameStatusBadge({ game }: { game: Pick<Game, "status" | "pending_play_url"> }) {
  const { t } = useI18n();
  if (game.status === "pending") return <span className="st st-in_progress">{t("game.status.pending")}</span>;
  if (game.status === "rejected") return <span className="st st-declined">{t("game.status.rejected")}</span>;
  if (game.pending_play_url) return <span className="st st-open">{t("game.status.newLink")}</span>;
  return null;
}

/** For the developer (and admins) on a game's page: why only they see it, or that a new link waits. */
export function ReviewNotice({ game }: { game: Pick<Game, "status" | "pending_play_url" | "review_note"> }) {
  const { t } = useI18n();
  const text =
    game.status === "pending" ? t("game.review.pending")
    : game.status === "rejected" ? t("game.review.rejected")
    : game.pending_play_url ? t("game.review.link", { url: game.pending_play_url })
    : "";
  if (!text) return null;
  return (
    <div className={`check ${game.status === "rejected" ? "warn" : ""} review-notice`} role="status">
      <p>{text}</p>
      {game.status === "rejected" && game.review_note && <p className="sub">{t("game.review.note", { note: game.review_note })}</p>}
    </div>
  );
}
