import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n, type Key } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { compact, findGame } from "../lib/games";
import { formatDuration, gameAnalytics, type Day, type GameAnalytics } from "../lib/analytics";
import { useTitle } from "../lib/useTitle";
import { NotFound } from "./NotFound";

const RANGES = [7, 30, 90, 365] as const;
type Measure = "plays" | "time";

/** A game's stats for its developer and admins: /game/:slug/stats */
export function GameStats() {
  const { slug = "" } = useParams();
  const { t, lang } = useI18n();
  const { games } = useGames();
  const game = findGame(games, slug);
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [measure, setMeasure] = useState<Measure>("plays");
  const [data, setData] = useState<GameAnalytics | null | undefined>(undefined);
  useTitle(game ? `${t("an.title")} · ${game.title}` : null);

  useEffect(() => {
    if (!game) return;
    let alive = true;
    setData(undefined);
    gameAnalytics(game.id, range).then((d) => alive && setData(d), () => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [game?.id, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const locale = lang === "de" ? "de-CH" : "en";
  const sums = useMemo(() => (data ? summarize(data.days, range) : null), [data, range]);

  if (games && !game) return <NotFound />;
  if (!game) return <p className="msg" aria-busy="true">{t("loading")}</p>;
  if (data === null) return <p className="msg">{t("an.notAllowed")}</p>;

  const dur = (s: number) => formatDuration(s, lang);
  return (
    <section className="game-stats">
      <div className="sechead">
        <div>
          <Link to={`/game/${game.slug}`} className="sub">← {game.title}</Link>
          <h1 className="h">{t("an.title")}</h1>
        </div>
        <div className="chips" role="group" aria-label={t("an.range")}>
          {RANGES.map((r) => (
            <button key={r} type="button" className={r === range ? "on" : ""} aria-pressed={r === range} onClick={() => setRange(r)}>
              {t("an.days", { n: r })}
            </button>
          ))}
        </div>
      </div>

      {!data || !sums ? (
        <div className="stat-tiles skel" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="tile" />)}</div>
      ) : (
        <>
          <div className="stat-tiles">
            <Tile label={t("an.plays")} value={compact(sums.plays)} now={sums.plays} before={sums.prevPlays} />
            <Tile label={t("an.playtime")} value={dur(sums.seconds)} now={sums.seconds} before={sums.prevSeconds} />
            <Tile label={t("an.perPlay")} value={dur(sums.plays ? sums.seconds / sums.plays : 0)} now={sums.plays ? sums.seconds / sums.plays : 0} before={sums.prevPlays ? sums.prevSeconds / sums.prevPlays : 0} />
            <Tile label={t("an.activePlayers")} value={compact(data.active_players)} hint={t("an.activeHint")} />
          </div>

          <section className="chart-card">
            <div className="chart-head">
              <h2>{measure === "plays" ? t("an.playsPerDay") : t("an.timePerDay")}</h2>
              <div className="seg" role="radiogroup" aria-label={t("an.show")}>
                {(["plays", "time"] as const).map((m) => (
                  <label key={m} className={measure === m ? "on" : ""}>
                    <input type="radio" name="measure" checked={measure === m} onChange={() => setMeasure(m)} />
                    {m === "plays" ? t("an.plays") : t("an.playtime")}
                  </label>
                ))}
              </div>
            </div>
            <BarChart
              days={sums.days}
              value={(d) => (measure === "plays" ? d[1] : d[2])}
              label={(v) => (measure === "plays" ? t("an.playsN", { n: v }) : dur(v))}
              axis={(v) => (measure === "plays" ? compact(v) : dur(v))}
              releases={data.releases}
              locale={locale}
              t={t}
            />
            {sums.best && sums.best[measure === "plays" ? 1 : 2] > 0 && (
              <p className="hint">
                {t("an.bestDay", {
                  day: new Date(sums.best[0]).toLocaleDateString(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }),
                  value: measure === "plays" ? t("an.playsN", { n: sums.best[1] }) : dur(sums.best[2]),
                })}
                {sums.weekday !== null && <> · {t("an.busiestWeekday", { day: weekdayName(sums.weekday, locale) })}</>}
              </p>
            )}
            <details className="chart-table">
              <summary>{t("an.asTable")}</summary>
              <table>
                <thead><tr><th>{t("an.day")}</th><th>{t("an.plays")}</th><th>{t("an.playtime")}</th></tr></thead>
                <tbody>
                  {[...sums.days].reverse().map((d) => (
                    <tr key={d[0]}><td>{new Date(d[0]).toLocaleDateString(locale, { timeZone: "UTC" })}</td><td>{d[1]}</td><td>{dur(d[2])}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <section>
            <div className="sechead"><h2>{t("an.allTime")}</h2></div>
            <dl className="stat-strip">
              <div><dt>{t("an.plays")}</dt><dd>{compact(data.plays)}</dd></div>
              <div><dt>{t("an.playtime")}</dt><dd>{dur(data.seconds)}</dd></div>
              <div><dt>{t("an.likes")}</dt><dd>{compact(data.likes)}</dd></div>
              <div><dt>{t("an.players")}</dt><dd>{compact(data.players)}</dd></div>
              <div><dt>{t("an.scores")}</dt><dd>{compact(data.scores)}</dd></div>
              <div><dt>{t("an.saves")}</dt><dd>{compact(data.saves)}</dd></div>
              <div>
                <dt>{t("an.openFeedback")}</dt>
                <dd><Link to={`/game/${game.slug}/feedback`}>{data.open_feedback}</Link>{data.open_bugs > 0 && <small> · {t("an.bugs", { n: data.open_bugs })}</small>}</dd>
              </div>
            </dl>
            <p className="note">{t("an.note")}</p>
          </section>
        </>
      )}
    </section>
  );
}

function Tile({ label, value, now, before, hint }: { label: string; value: string; now?: number; before?: number; hint?: string }) {
  const { t } = useI18n();
  let change: string | null = null;
  if (now !== undefined && before !== undefined) {
    if (before > 0) {
      const pct = Math.round(((now - before) / before) * 100);
      change = pct === 0 ? t("an.same") : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
    } else if (now > 0) change = t("an.new");
  }
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <b>{value}</b>
      {change && <span className="sub">{t("an.vsBefore", { change })}</span>}
      {hint && <span className="sub">{hint}</span>}
    </div>
  );
}

function BarChart({ days, value, label, axis, releases, locale, t }: {
  days: Day[];
  value: (d: Day) => number;
  label: (v: number) => string;
  axis: (v: number) => string;
  releases: { version: string; day: string }[];
  locale: string;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map(value));
  const byDay = new Map<string, string[]>();
  for (const r of releases) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r.version]);
  const fmt = (d: string, long = false) =>
    new Date(d).toLocaleDateString(locale, { timeZone: "UTC", day: "numeric", month: "short", ...(long ? { weekday: "short" } : {}) });
  const shown = hover !== null ? days[hover] : null;
  const total = days.reduce((a, d) => a + value(d), 0);

  return (
    <div className="bars-wrap">
      <p className="bars-readout" aria-live="polite">
        {shown ? (
          <>
            <b>{fmt(shown[0], true)}</b> · {label(value(shown))}
            {byDay.has(shown[0]) && <> · {t("an.update", { version: byDay.get(shown[0])!.join(", ") })}</>}
          </>
        ) : (
          <>{t("an.total")}: <b>{label(total)}</b></>
        )}
      </p>
      <div className="bars-plot">
        <span className="bars-max" aria-hidden="true">{axis(max)}</span>
        <div
          className="bars"
          role="img"
          aria-label={`${t("an.total")}: ${label(total)}`}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.floor(((e.clientX - r.left) / r.width) * days.length);
            setHover(Math.min(days.length - 1, Math.max(0, i)));
          }}
        >
          {days.map((d, i) => {
            const v = value(d);
            return (
              <span key={d[0]} className={`bar${hover === i ? " on" : ""}${v ? "" : " zero"}`}>
                <i style={{ height: v ? `${Math.max(2, (v / max) * 100)}%` : undefined }} />
                {byDay.has(d[0]) && <em className="release-mark" />}
              </span>
            );
          })}
        </div>
      </div>
      <div className="bars-axis" aria-hidden="true">
        <span>{fmt(days[0][0])}</span>
        {days.length > 2 && <span>{fmt(days[Math.floor(days.length / 2)][0])}</span>}
        <span>{fmt(days[days.length - 1][0])}</span>
      </div>
      {releases.length > 0 && <p className="hint legend"><em className="release-mark" /> {t("an.releaseLegend")}</p>}
    </div>
  );
}

/** Splits the days into this period and the one before, and finds the best day and weekday. */
function summarize(all: Day[], range: number) {
  const days = all.slice(-range);
  const before = all.slice(0, Math.max(0, all.length - range));
  const sum = (list: Day[], i: 1 | 2) => list.reduce((a, d) => a + d[i], 0);
  const best = days.reduce<Day | null>((b, d) => (!b || d[1] > b[1] || (d[1] === b[1] && d[2] > b[2]) ? d : b), null);
  // Busiest weekday: only meaningful with at least two weeks of days.
  let weekday: number | null = null;
  if (days.length >= 14) {
    const per = Array(7).fill(0) as number[];
    for (const d of days) per[new Date(d[0]).getUTCDay()] += d[1];
    const top = Math.max(...per);
    weekday = top > 0 ? per.indexOf(top) : null;
  }
  return {
    days, best, weekday,
    plays: sum(days, 1), seconds: sum(days, 2),
    prevPlays: sum(before, 1), prevSeconds: sum(before, 2),
  };
}

function weekdayName(day: number, locale: string): string {
  // 4 Jan 1970 was a Sunday (day 0).
  return new Date(Date.UTC(1970, 0, 4 + day)).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
}
