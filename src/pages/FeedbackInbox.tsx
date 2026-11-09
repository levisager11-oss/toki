import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { useVotes } from "../lib/useVotes";
import {
  inboxPosts, isClosed, KINDS, needsReply, STATUSES, summarize, updatePost,
  type FeedbackKind, type FeedbackPost, type FeedbackStatus, type StatusFilter,
} from "../lib/feedback";
import { ListSkeleton, PostRow, useStatusLabel } from "../components/FeedbackBits";
import { SummaryButton } from "../components/AiBits";
import { summarizeInbox } from "../lib/assist";
import { useTitle } from "../lib/useTitle";

const TOKI = "toki";

/** The developer's dashboard: feedback for their games (admins: all games and Toki) at /feedback/inbox. */
export function FeedbackInbox() {
  const { t, lang } = useI18n();
  useTitle(t("fb.inbox.title"));
  const { profile } = useAuth();
  const { games, error: gamesError } = useGames();
  const statusLabel = useStatusLabel();
  const [posts, setPosts] = useState<FeedbackPost[] | null>(null);
  const [error, setError] = useState(false);
  const [game, setGame] = useState(""); // "" all, a game id, or TOKI
  const [kind, setKind] = useState<FeedbackKind | undefined>();
  const [status, setStatus] = useState<StatusFilter>("active");
  const [onlyNeedsReply, setOnlyNeedsReply] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const { voted, vote } = useVotes(posts, (f) => setPosts((p) => (p ? f(p) : p)));

  const isAdmin = profile?.role === "admin";
  const mine = useMemo(() => (games ?? []).filter((g) => isAdmin || g.created_by === profile?.id), [games, isAdmin, profile?.id]);
  const ids = mine.map((g) => g.id).join(",");

  useEffect(() => {
    if (!games || !profile) return;
    let alive = true;
    inboxPosts(isAdmin ? "all" : ids ? ids.split(",") : [])
      .then((p) => alive && setPosts(p))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [games, profile, isAdmin, ids]);

  const ofGame = useMemo(
    () => (posts ?? []).filter((p) => !game || (game === TOKI ? p.game_id === null : p.game_id === game)),
    [posts, game],
  );
  const summary = useMemo(() => summarize(ofGame), [ofGame]);
  const shown = ofGame.filter(
    (p) =>
      (!kind || p.kind === kind) &&
      (status === "all" || (status === "closed") === isClosed(p.status)) &&
      (!onlyNeedsReply || needsReply(p)),
  );

  const setPostStatus = async (p: FeedbackPost, s: FeedbackStatus) => {
    setSaving(p.id);
    try {
      const u = await updatePost(p.id, { status: s });
      setPosts((list) => list?.map((x) => (x.id === u.id ? u : x)) ?? null);
    } catch {
      setError(true);
    }
    setSaving(null);
  };
  const tile = (key: string, n: number, label: string, on: boolean, apply: () => void) => (
    <button key={key} type="button" className={`fb-tile ${on ? "on" : ""}`} aria-pressed={on} onClick={apply}>
      <b>{n}</b>
      <span>{label}</span>
    </button>
  );

  if (gamesError || error) return <p className="msg">{t("error")}</p>;

  return (
    <section className="fb-board">
      <h1 className="h">{t("fb.inbox.title")}</h1>
      <p className="lead">{t(isAdmin ? "fb.inbox.leadAdmin" : "fb.inbox.lead")}</p>

      {!posts ? (
        <ListSkeleton />
      ) : posts.length === 0 ? (
        <div className="msg">
          <p>{t(mine.length ? "fb.inbox.empty" : "my.empty")}</p>
          {!mine.length && <Link to="/add" className="btn primary">{t("my.add")}</Link>}
        </div>
      ) : (
        <>
          <SummaryButton key={game} label={t("fb.inbox.aiSummary")} load={() => summarizeInbox(game || null, lang)} />
          <div className="fb-tiles">
            {tile("reply", summary.needsReply, t("fb.inbox.needsReply"), onlyNeedsReply, () => {
              setOnlyNeedsReply(!onlyNeedsReply);
              setStatus("active");
            })}
            {tile("bugs", summary.bugs, t("fb.inbox.bugs"), kind === "bug" && status === "active", () => {
              setKind(kind === "bug" && status === "active" ? undefined : "bug");
              setStatus("active");
            })}
            {tile("ideas", summary.ideas, t("fb.inbox.ideas"), kind === "idea" && status === "active", () => {
              setKind(kind === "idea" && status === "active" ? undefined : "idea");
              setStatus("active");
            })}
            {tile("done", summary.done, t("fb.inbox.done"), status === "closed", () => {
              setStatus(status === "closed" ? "active" : "closed");
              setOnlyNeedsReply(false);
            })}
          </div>

          <div className="fb-tools">
            <div className="chips" role="group" aria-label={t("fb.form.kind")}>
              <button type="button" className={!kind ? "on" : ""} aria-pressed={!kind} onClick={() => setKind(undefined)}>{t("fb.kinds.all")}</button>
              {KINDS.map((k) => (
                <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`fb.kind.${k}`)}</button>
              ))}
            </div>
            <div className="fb-selects">
              {(mine.length > 1 || isAdmin) && (
                <label>
                  <span className="sr-only">{t("fb.inbox.game")}</span>
                  <select value={game} onChange={(e) => setGame(e.target.value)}>
                    <option value="">{t("fb.inbox.allGames")}</option>
                    {isAdmin && <option value={TOKI}>{t("fb.inbox.toki")}</option>}
                    {mine.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span className="sr-only">{t("fb.filter.label")}</span>
                <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  {(["active", "closed", "all"] as const).map((f) => <option key={f} value={f}>{t(`fb.filter.${f}`)}</option>)}
                </select>
              </label>
            </div>
          </div>
          <label className="fb-toggle">
            <input type="checkbox" checked={onlyNeedsReply} onChange={(e) => setOnlyNeedsReply(e.target.checked)} />
            {t("fb.inbox.onlyNeedsReply")}
          </label>

          {shown.length === 0 ? (
            <p className="msg">{t("fb.inbox.noMatch")}</p>
          ) : (
            <ul className="fb-list">
              {shown.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  voted={voted.has(p.id)}
                  onVote={(on) => vote(p, on)}
                  showGame={mine.length > 1 || isAdmin}
                  extra={
                    <div className="fb-quick">
                      {needsReply(p) && <span className="fb-needs">{t("fb.inbox.needsReplyTag")}</span>}
                      <label>
                        <span className="sr-only">{t("fb.post.status")}: {p.title}</span>
                        <select value={p.status} disabled={saving === p.id} onChange={(e) => setPostStatus(p, e.target.value as FeedbackStatus)}>
                          {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(p.kind, s)}</option>)}
                        </select>
                      </label>
                    </div>
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
