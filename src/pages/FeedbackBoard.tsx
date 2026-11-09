import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { findGame } from "../lib/games";
import { useVotes } from "../lib/useVotes";
import { KINDS, listPosts, PAGE, type FeedbackKind, type FeedbackPost, type Sort, type StatusFilter } from "../lib/feedback";
import { FeedbackForm } from "../components/FeedbackForm";
import { ListSkeleton, PostRow } from "../components/FeedbackBits";

const FILTERS: StatusFilter[] = ["active", "closed", "all"];
const asKind = (v: string | null) => (KINDS as readonly string[]).includes(v ?? "") ? (v as FeedbackKind) : undefined;

/** Bug reports and ideas for one game (/game/:slug/feedback) or for Toki itself (/feedback). */
export function FeedbackBoard() {
  const { slug } = useParams();
  const { t } = useI18n();
  const { session } = useAuth();
  const { games, error: gamesError } = useGames();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const kind = asKind(params.get("kind"));
  const status: StatusFilter = FILTERS.includes(params.get("show") as StatusFilter) ? (params.get("show") as StatusFilter) : "active";
  const sort: Sort = params.get("sort") === "new" ? "new" : "top";
  const writing = asKind(params.get("new"));

  const game = slug ? findGame(games, slug) : undefined;
  // undefined while the game is still loading; null for Toki itself
  const gameId = slug ? game?.id : null;
  const [posts, setPosts] = useState<FeedbackPost[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const { voted, vote } = useVotes(posts, (f) => setPosts((p) => (p ? f(p) : p)));

  useEffect(() => {
    if (gameId === undefined) return;
    let alive = true;
    setPosts(null);
    setError(false);
    listPosts({ gameId, kind, status, sort })
      .then((p) => {
        if (!alive) return;
        setPosts(p);
        setHasMore(p.length === PAGE);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [gameId, kind, status, sort]);

  const title = game ? t("fb.gameTitle", { title: game.title }) : t("fb.tokiTitle");
  useEffect(() => {
    document.title = `${title} · Toki`;
    return () => {
      document.title = "Toki";
    };
  }, [title]);

  const set = (key: string, value: string | undefined) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });

  const loadMore = async () => {
    if (!posts || gameId === undefined) return;
    setLoadingMore(true);
    try {
      const page = await listPosts({ gameId, kind, status, sort, offset: posts.length });
      setPosts((p) => {
        const have = new Set(p?.map((x) => x.id));
        return [...(p ?? []), ...page.filter((x) => !have.has(x.id))];
      });
      setHasMore(page.length === PAGE);
    } catch {
      setError(true);
    }
    setLoadingMore(false);
  };

  if (gamesError) return <p className="msg">{t("error")}</p>;
  if (slug && games && !game)
    return (
      <div className="msg">
        <p>{t("game.notFound")}</p>
        <Link to="/" className="btn">{t("back")}</Link>
      </div>
    );

  const loginNext = `/login?next=${encodeURIComponent(`${location.pathname}?new=bug`)}`;

  return (
    <section className="fb-board">
      {slug && <Link to={`/game/${slug}`} className="back">← {t("fb.backToGame")}</Link>}
      <h1 className="h">{title}</h1>
      <p className="lead">{t(slug ? "fb.lead.game" : "fb.lead.toki")}</p>

      {writing && session ? (
        <FeedbackForm
          key={writing}
          gameId={gameId ?? null}
          kind={writing}
          posts={posts ?? []}
          onCancel={() => set("new", undefined)}
          onPosted={(p) => navigate(`/feedback/${p.id}`, { state: { posted: true } })}
        />
      ) : (
        <div className="actions">
          {session ? (
            <>
              <button type="button" className="btn primary" onClick={() => set("new", "bug")}>{t("fb.reportBug")}</button>
              <button type="button" className="btn" onClick={() => set("new", "idea")}>{t("fb.suggest")}</button>
            </>
          ) : (
            <Link to={loginNext} className="btn primary">{t("fb.loginToPost")}</Link>
          )}
        </div>
      )}

      <div className="fb-tools">
        <div className="chips" role="group" aria-label={t("fb.form.kind")}>
          <button type="button" className={!kind ? "on" : ""} aria-pressed={!kind} onClick={() => set("kind", undefined)}>{t("fb.kinds.all")}</button>
          {KINDS.map((k) => (
            <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => set("kind", k)}>{t(`fb.kind.${k}`)}</button>
          ))}
        </div>
        <div className="fb-selects">
          <label>
            <span className="sr-only">{t("fb.filter.label")}</span>
            <select value={status} onChange={(e) => set("show", e.target.value === "active" ? undefined : e.target.value)}>
              {FILTERS.map((f) => <option key={f} value={f}>{t(`fb.filter.${f}`)}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">{t("fb.sort.label")}</span>
            <select value={sort} onChange={(e) => set("sort", e.target.value === "top" ? undefined : e.target.value)}>
              <option value="top">{t("fb.sort.top")}</option>
              <option value="new">{t("fb.sort.new")}</option>
            </select>
          </label>
        </div>
      </div>

      {error ? (
        <p className="msg">{t("error")}</p>
      ) : !posts ? (
        <ListSkeleton />
      ) : posts.length === 0 ? (
        <p className="msg fb-empty">{t(!kind && status === "active" ? "fb.emptyFirst" : "fb.empty")}</p>
      ) : (
        <>
          <ul className="fb-list" aria-busy={loadingMore}>
            {posts.map((p) => <PostRow key={p.id} post={p} voted={voted.has(p.id)} onVote={(on) => vote(p, on)} />)}
          </ul>
          {hasMore && (
            <button type="button" className="btn fb-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? t("loading") : t("fb.loadMore")}</button>
          )}
        </>
      )}
    </section>
  );
}
