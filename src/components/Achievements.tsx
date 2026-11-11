import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { achievementText } from "../lib/achievementRules";
import type { AchievementRow, Badge } from "../lib/achievements";
import type { Game } from "../lib/types";

const TOAST_MS = 4000;
// The game page shows this many, and the rest behind "Show all".
const SHOWN = 6;

/**
 * "Achievement unlocked", over the game (but part of Toki's page, so it also shows in
 * fullscreen). One at a time; each goes after a few seconds or when tapped.
 */
export function AchievementToast({ toast, guest, onDone }: { toast: AchievementRow | null; guest: boolean; onDone: () => void }) {
  const { t, lang } = useI18n();
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, onDone]);
  return (
    <div className="ach-toast-spot" role="status" aria-live="polite">
      {toast && (
        <button type="button" key={toast.id} className="ach-toast" onClick={onDone}>
          <span className="ach-icon" aria-hidden="true">{toast.icon}</span>
          <span className="ach-toast-text">
            <small>{t("ach.unlocked")}</small>
            <b>{achievementText(toast, lang).name}</b>
            {guest && <small>{t("ach.guestKeep")}</small>}
          </span>
        </button>
      )}
    </div>
  );
}

/** The game's achievements on its page: how many players have each, and which the viewer has. */
export function AchievementList({ rows, viewer }: { rows: AchievementRow[] | null; viewer: boolean }) {
  const { t, lang } = useI18n();
  const [all, setAll] = useState(false);
  if (!rows?.length) return null;
  const have = rows.filter((r) => r.mine).length;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <section id="achievements" className="achievements">
      <div className="sechead">
        <h2>{t("ach.title")}</h2>
        {viewer && <span className="sub">{t("ach.have", { n: have, total: rows.length })}</span>}
      </div>
      <ul className="ach-list">
        {shown.map((a) => {
          const text = achievementText(a, lang);
          return (
            <li key={a.id} className={a.mine ? "mine" : ""}>
              <span className="ach-icon" aria-hidden="true">{a.icon}</span>
              <span className="info">
                <b>{text.name}{a.mine && <span className="ach-got" title={t("ach.yours")}> ✓<span className="sr-only">{t("ach.yours")}</span></span>}</b>
                {text.description && <span className="sub">{text.description}</span>}
              </span>
              <span className="ach-count">{a.players ? t("ach.players", { n: a.players }) : t("ach.nobody")}</span>
            </li>
          );
        })}
      </ul>
      {rows.length > SHOWN && (
        <button type="button" className="linkish" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? t("ach.showLess") : t("ach.showAll", { n: rows.length })}
        </button>
      )}
    </section>
  );
}

/** A player's badges on their profile, newest first, each with its game. */
export function BadgeRow({ badges, total, games }: { badges: Badge[]; total: number; games: Map<string, Game> }) {
  const { t, lang } = useI18n();
  const list = badges.filter((b) => games.has(b.game_id));
  if (!list.length) return null;
  return (
    <section>
      <div className="sechead">
        <h2>{t("ach.title")}</h2>
        <span className="sub">{t("ach.total", { n: total })}</span>
      </div>
      <ul className="badge-row">
        {list.map((b) => {
          const g = games.get(b.game_id)!;
          const text = achievementText(b, lang);
          return (
            <li key={`${b.game_id}:${b.id}`}>
              <Link to={`/game/${g.slug}#achievements`} title={text.description || undefined}>
                <span className="ach-icon" aria-hidden="true">{b.icon}</span>
                <span className="info">
                  <b>{text.name}</b>
                  <span className="sub">{g.title}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
