// How scores are shown. Kept apart from social.ts so server code (link previews) can use it
// without the Supabase client.
export type ScoreFormat = "points" | "time";

/** A score as players read it: 12,345 points, or a time like 1:02.345. */
export function formatScore(score: number, format: ScoreFormat | undefined, lang: "en" | "de"): string {
  if (format === "time") {
    const neg = score < 0;
    const ms = Math.abs(Math.round(score));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const rest = String(ms % 1000).padStart(3, "0");
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return `${neg ? "-" : ""}${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}.${rest}`;
  }
  return Math.round(score).toLocaleString(lang === "de" ? "de-CH" : "en");
}


/** Where a shared score leads. With the player's name, the link preview shows their best score as a picture. */
export const scoreSharePath = (slug: string, username?: string | null) =>
  `/game/${slug}${username ? `?by=${encodeURIComponent(username)}` : ""}#scores`;
