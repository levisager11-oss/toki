import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { SITE_URL } from "../lib/site";

/** The "Play on Toki" button for a game, as HTML (websites) and Markdown (GitHub READMEs, itch.io). */
export function badgeCode(slug: string, light = false) {
  const img = `${SITE_URL}/badge${light ? "-light" : ""}.svg`;
  const link = `${SITE_URL}/game/${slug}`;
  return {
    html: `<a href="${link}"><img src="${img}" alt="Play on Toki" height="44"></a>`,
    markdown: `[![Play on Toki](${img})](${link})`,
  };
}

/**
 * On My games: a "Play on Toki" button developers can put on their website, GitHub README or
 * devlog, so the people who find the game there come to play it on Toki.
 */
export function TokiBadge({ games }: { games: { slug: string; title: string }[] }) {
  const { t } = useI18n();
  const [slug, setSlug] = useState(games[0]?.slug ?? "");
  const [light, setLight] = useState(false);
  const [copied, setCopied] = useState<"html" | "markdown" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  useEffect(() => {
    if (!games.some((g) => g.slug === slug)) setSlug(games[0]?.slug ?? "");
  }, [games, slug]);
  if (!games.length || !slug) return null;
  const code = badgeCode(slug, light);
  const copy = (kind: "html" | "markdown") =>
    navigator.clipboard?.writeText(code[kind]).then(() => setCopied(kind), () => {});

  return (
    <section className="panel toki-badge" id="badge" aria-labelledby="badge-h">
      <h2 className="h" id="badge-h">{t("badge.title")}</h2>
      <p className="lead">{t("badge.lead")}</p>
      <div className="badge-row">
        {games.length > 1 && (
          <select value={slug} onChange={(e) => setSlug(e.target.value)} aria-label={t("badge.game")}>
            {games.map((g) => <option key={g.slug} value={g.slug}>{g.title}</option>)}
          </select>
        )}
        <div className="chips" role="group" aria-label={t("badge.style")}>
          <button type="button" className={light ? "" : "on"} aria-pressed={!light} onClick={() => setLight(false)}>{t("badge.dark")}</button>
          <button type="button" className={light ? "on" : ""} aria-pressed={light} onClick={() => setLight(true)}>{t("badge.light")}</button>
        </div>
      </div>
      <a href={`${SITE_URL}/game/${slug}`} className="badge-preview" target="_blank" rel="noreferrer">
        <img src={`/badge${light ? "-light" : ""}.svg`} alt="Play on Toki" height={44} />
      </a>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => copy("html")} aria-live="polite">
          {copied === "html" ? t("badge.copied") : t("badge.copyHtml")}
        </button>
        <button type="button" className="btn" onClick={() => copy("markdown")} aria-live="polite">
          {copied === "markdown" ? t("badge.copied") : t("badge.copyMarkdown")}
        </button>
      </div>
    </section>
  );
}
