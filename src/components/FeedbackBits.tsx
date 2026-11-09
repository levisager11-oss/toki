import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago, type FeedbackKind, type FeedbackPost, type FeedbackStatus } from "../lib/feedback";
import { ChatIcon, LockIcon } from "./icons";

/** Bugs get their own words for each status ("Fixed" instead of "Done"). */
export function useStatusLabel() {
  const { t } = useI18n();
  return (kind: FeedbackKind, status: FeedbackStatus) => t(kind === "bug" ? `fb.bugStatus.${status}` : `fb.status.${status}`);
}

export function StatusBadge({ kind, status }: { kind: FeedbackKind; status: FeedbackStatus }) {
  const label = useStatusLabel();
  return <span className={`st st-${status}`}>{label(kind, status)}</span>;
}

export function KindTag({ kind }: { kind: FeedbackKind }) {
  const { t } = useI18n();
  return <span className={`kd kd-${kind}`}>{t(`fb.kind.${kind}`)}</span>;
}

/** Up-vote with the count. Visitors without an account are sent to log in. */
export function VoteButton({ post, voted, onVote }: { post: FeedbackPost; voted: boolean; onVote: (on: boolean) => void }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  const count = <span className="n">{post.vote_count}</span>;
  const label = `${voted ? t("fb.unvote") : t("fb.vote")} (${t("fb.votes", { n: post.vote_count })})`;
  if (!session)
    return (
      <Link to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} className="vote" aria-label={`${t("fb.loginToPost")} (${t("fb.votes", { n: post.vote_count })})`} title={t("fb.loginToPost")}>
        <UpIcon />{count}
      </Link>
    );
  return (
    <button type="button" className="vote" aria-pressed={voted} aria-label={label} title={voted ? t("fb.unvote") : t("fb.vote")} onClick={() => onVote(!voted)}>
      <UpIcon />{count}
    </button>
  );
}

const UpIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3 14 11H2z" fill="currentColor" /></svg>
);

/** Author, time, replies and markers, under a post's title. */
export function PostMeta({ post, showGame }: { post: FeedbackPost; showGame?: boolean }) {
  const { t, lang } = useI18n();
  return (
    <span className="fb-meta">
      <KindTag kind={post.kind} />
      <StatusBadge kind={post.kind} status={post.status} />
      {post.private && <span className="fb-flag"><LockIcon />{t("fb.private")}</span>}
      {post.hidden && <span className="fb-flag">{t("fb.hidden")}</span>}
      {showGame && <b>{post.game?.title ?? t("fb.inbox.toki")}</b>}
      <span>@{post.author?.username ?? "?"}</span>
      <time dateTime={post.created_at} title={new Date(post.created_at).toLocaleString(lang === "de" ? "de-CH" : "en")}>{ago(post.created_at, lang)}</time>
      {post.reply_count > 0 && (
        <span className="fb-replies" title={t("fb.replies", { n: post.reply_count })}>
          <ChatIcon /><span aria-hidden="true">{post.reply_count}</span><span className="sr-only">{t("fb.replies", { n: post.reply_count })}</span>
        </span>
      )}
      {post.answered && <span className="fb-answered">✓ {t("fb.answered")}</span>}
    </span>
  );
}

export function PostRow({ post, voted, onVote, showGame, extra }: {
  post: FeedbackPost;
  voted: boolean;
  onVote: (on: boolean) => void;
  showGame?: boolean;
  extra?: ReactNode;
}) {
  return (
    <li className="fb-row">
      <VoteButton post={post} voted={voted} onVote={onVote} />
      <div className="fb-main">
        <Link to={`/feedback/${post.id}`} className="fb-title">{post.title}</Link>
        <PostMeta post={post} showGame={showGame} />
      </div>
      {extra}
    </li>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="fb-list skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li className="fb-row" key={i}>
          <span className="vote" />
          <div className="fb-main"><span className="bar" style={{ width: "60%" }} /><span className="bar" style={{ width: "35%" }} /></div>
        </li>
      ))}
    </ul>
  );
}
