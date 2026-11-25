import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import {
  averageStars, countUnanswered, deleteReview, listReviews, reviewBreakdown, replyReview, REVIEW_MAX, reviewErrorKey, reviewStatus, saveReview,
  type Review, type ReviewSort, type ReviewStatus,
} from "../lib/reviews";
import type { Game } from "../lib/types";
import { patchGame } from "../lib/useGames";
import { Avatar } from "./Avatar";
import { Name, Stars } from "./Looks";
import { ReportButton } from "./ReportButton";

const SHOWN = 5;
const SORTS: ReviewSort[] = ["newest", "highest", "lowest", "text", "unanswered"];

/** A small bar per star value, 5 to 1, with how many reviews gave it. */
function Breakdown({ rows }: { rows: { stars: number; n: number }[] }) {
  const { t } = useI18n();
  const total = rows.reduce((a, r) => a + r.n, 0);
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="rev-break" aria-label={t("rev.breakdown", { n: total })}>
      {rows.map((r) => (
        <li key={r.stars} aria-label={t("rev.breakRow", { stars: r.stars, n: r.n })}>
          <span aria-hidden="true" className="rev-break-l">{r.stars}</span>
          <span aria-hidden="true" className="rev-bar"><span style={{ width: `${(r.n / max) * 100}%` }} /></span>
          <span aria-hidden="true" className="rev-break-n">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}

/** Reviews with stars on a game's page: the player's own, and everyone's with the developer's answers. */
export function Reviews({ game }: { game: Game }) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const location = useLocation();
  const [list, setList] = useState<Review[] | null>(null);
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  const [sort, setSort] = useState<ReviewSort>("newest");
  const [breakdown, setBreakdown] = useState<{ stars: number; n: number }[] | null>(null);
  const [unanswered, setUnanswered] = useState(0);
  const manager = !!profile && (profile.role === "admin" || profile.id === game.created_by);

  useEffect(() => {
    let alive = true;
    listReviews(game.id, sort).then((l) => {
      if (!alive) return;
      setList(l);
      setFailed(false);
    }, () => alive && setFailed(true));
    reviewBreakdown(game.id).then((b) => alive && setBreakdown(b), () => {});
    if (manager) countUnanswered(game.id).then((c) => alive && setUnanswered(c), () => {});
    if (profile) reviewStatus(game.id).then((s) => alive && setStatus(s), () => {});
    else setStatus(null);
    return () => {
      alive = false;
    };
  }, [game.id, profile?.id, n, sort, manager]);
  // Another game: nothing of the last one stays.
  useEffect(() => {
    setList(null);
    setStatus(null);
    setAll(false);
    setFailed(false);
    setBreakdown(null);
    setUnanswered(0);
    setSort("newest");
  }, [game.id]);
  useEffect(() => setAll(false), [sort]);

  const shownList = (list ?? []).filter((r) => r.user_id !== profile?.id);
  const visible = all ? shownList : shownList.slice(0, SHOWN);
  const avg = averageStars(game.stats);
  const changed = (stats?: { reviews: number; stars: number }) => {
    setN((x) => x + 1);
    if (stats) patchGame(game.id, (g) => ({ ...g, stats: { plays: g.stats?.plays ?? 0, likes: g.stats?.likes ?? 0, ...stats } }));
  };

  return (
    <section className="reviews" id="reviews" aria-labelledby="reviews-h">
      <div className="sechead">
        <h2 id="reviews-h">{t("rev.title")}</h2>
        {avg !== null && (
          <span className="rev-avg">
            <Stars value={avg} size={16} label={t("rev.average", { avg: avg.toFixed(1) })} />
            <b>{avg.toLocaleString(lang === "de" ? "de-CH" : "en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}</b>
            <span className="sub">{t("rev.count", { n: game.stats?.reviews ?? 0 })}</span>
          </span>
        )}
      </div>

      {!profile ? (
        <p className="hint"><Link to={`/login?next=${encodeURIComponent(location.pathname + "#reviews")}`}>{t("rev.login")}</Link></p>
      ) : status && !status.own ? (
        status.seconds < status.needed && !status.review ? (
          <p className="hint">{t("rev.playMore", { n: Math.max(1, Math.ceil((status.needed - status.seconds) / 60)) })}</p>
        ) : (
          <MyReview key={game.id} game={game} mine={status.review} onChange={changed} />
        )
      ) : null}

      {failed && <p className="error" role="alert">{t("error")}</p>}
      {breakdown && breakdown.some((b) => b.n > 0) && <Breakdown rows={breakdown} />}

      {(game.stats?.reviews ?? 0) > 0 || sort !== "newest" ? (
        <div className="chips rev-sort" role="group" aria-label={t("rev.sort")}>
          {(manager ? SORTS : SORTS.filter((s) => s !== "unanswered")).map((s) => (
            <button key={s} type="button" className={sort === s ? "on" : ""} aria-pressed={sort === s} onClick={() => setSort(s)}>
              {t(`rev.sort.${s}` as "error")}
              {s === "unanswered" && unanswered > 0 && <span className="rev-badge">{unanswered}</span>}
            </button>
          ))}
        </div>
      ) : null}

      {list === null ? null : shownList.length === 0 ? (
        <p className="msg">{t(sort === "newest" ? "rev.none" : "rev.noneFiltered")}</p>
      ) : (
        <ul className="rev-list">
          {visible.map((r) => (
            <ReviewItem key={r.id} r={r} canReply={manager} mine={false} onChange={() => setN((x) => x + 1)} />
          ))}
        </ul>
      )}
      {!all && shownList.length > SHOWN && (
        <button type="button" className="linkish" onClick={() => setAll(true)}>{t("rev.all", { n: shownList.length })}</button>
      )}
    </section>
  );
}

/** The logged-in player's own review: stars and a few words, to write or change. */
function MyReview({ game, mine, onChange }: { game: Game; mine: ReviewStatus["review"]; onChange: (stats?: { reviews: number; stars: number }) => void }) {
  const { t } = useI18n();
  const [stars, setStars] = useState(mine?.stars ?? 0);
  const [body, setBody] = useState(mine?.body ?? "");
  const [editing, setEditing] = useState(!mine);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sure, setSure] = useState(false);
  useEffect(() => {
    setStars(mine?.stars ?? 0);
    setBody(mine?.body ?? "");
    setEditing(!mine);
  }, [mine?.id, mine?.stars, mine?.body]);

  const reviews = game.stats?.reviews ?? 0;
  const sum = game.stats?.stars ?? 0;
  const save = async () => {
    if (!stars) return setErr(t("rev.pickStars"));
    setBusy(true);
    setErr("");
    try {
      await saveReview(game.id, stars, body);
      onChange(mine ? { reviews, stars: sum - mine.stars + stars } : { reviews: reviews + 1, stars: sum + stars });
    } catch (e) {
      setErr(t(reviewErrorKey(e) as "error"));
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!mine) return;
    if (!sure) return setSure(true);
    setBusy(true);
    setErr("");
    try {
      await deleteReview(game.id);
      onChange({ reviews: Math.max(0, reviews - 1), stars: Math.max(0, sum - mine.stars) });
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
    setSure(false);
  };

  if (mine && !editing) {
    return (
      <div className="rev-mine">
        <span className="label">{t("rev.yours")}</span>
        <p><Stars value={mine.stars} /> {mine.body}</p>
        {mine.hidden && <p className="check warn">{t("rev.hidden")}</p>}
        {mine.reply && <p className="rev-reply"><span className="label">{t("rev.reply")}</span> {mine.reply}</p>}
        <div className="actions">
          <button type="button" className="btn small" onClick={() => setEditing(true)}>{t("rev.edit")}</button>
          <button type="button" className={`btn small ${sure ? "danger" : "ghost-danger"}`} disabled={busy} onClick={remove}>{t(sure ? "rev.deleteSure" : "rev.delete")}</button>
        </div>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    );
  }
  return (
    <form className="rev-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset className="star-pick">
        <legend>{t(mine ? "rev.change" : "rev.write")}</legend>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} type="button" className={i <= stars ? "on" : ""} aria-pressed={i === stars} aria-label={t("rev.stars", { n: i })} onClick={() => setStars(i)}>
            <Stars value={i <= stars ? 1 : 0} size={24} label="" />
          </button>
        ))}
      </fieldset>
      <label htmlFor="rev-body" className="sr-only">{t("rev.text")}</label>
      <textarea id="rev-body" rows={3} maxLength={REVIEW_MAX} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("rev.placeholder")} />
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        {mine && <button type="button" className="btn" onClick={() => setEditing(false)}>{t("form.cancel")}</button>}
        <button type="submit" className="btn primary" disabled={busy}>{t("rev.save")}</button>
      </div>
      <p className="hint">{t("rev.rules")}</p>
    </form>
  );
}

function ReviewItem({ r, canReply, mine, onChange }: { r: Review; canReply: boolean; mine: boolean; onChange: () => void }) {
  const { t, lang } = useI18n();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState(r.reply ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      await replyReview(r.id, text);
      setReplying(false);
      onChange();
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
  };
  return (
    <li className={r.hidden ? "hidden-post" : ""}>
      <div className="rev-head">
        {r.author && <Link to={`/u/${r.author.username}`} className="person"><Avatar person={r.author} size={28} /><Name person={r.author} /></Link>}
        <Stars value={r.stars} />
        <time className="sub" dateTime={r.created_at}>{ago(r.created_at, lang)}{r.edited_at ? ` · ${t("rev.edited")}` : ""}</time>
      </div>
      {r.body && <p className="rev-body">{r.body}</p>}
      {r.hidden && <p className="check warn">{t("rev.hiddenDev")}</p>}
      {r.reply && !replying && <p className="rev-reply"><span className="label">{t("rev.reply")}</span> {r.reply}</p>}
      {replying ? (
        <form className="rev-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label htmlFor={`reply-${r.id}`} className="sr-only">{t("rev.replyLabel")}</label>
          <textarea id={`reply-${r.id}`} rows={2} maxLength={REVIEW_MAX} value={text} onChange={(e) => setText(e.target.value)} />
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="btn small" onClick={() => setReplying(false)}>{t("form.cancel")}</button>
            <button type="submit" className="btn small primary" disabled={busy}>{t("rev.sendReply")}</button>
          </div>
        </form>
      ) : (
        <div className="rev-actions">
          {canReply && <button type="button" className="linkish" onClick={() => setReplying(true)}>{t(r.reply ? "rev.editReply" : "rev.replyLabel")}</button>}
          {!mine && <ReportButton kind="review" target={r.id} />}
        </div>
      )}
    </li>
  );
}
