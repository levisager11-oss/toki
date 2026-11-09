import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago, myPosts, type FeedbackPost } from "../lib/feedback";
import { KindTag, StatusBadge } from "./FeedbackBits";
import { ChatIcon } from "./icons";

/** On the account page: the player's own bug reports and ideas, with their status. */
export function MyFeedback() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [posts, setPosts] = useState<FeedbackPost[] | null>(null);

  useEffect(() => {
    if (!profile) return;
    let alive = true;
    myPosts(profile.id).then((p) => alive && setPosts(p)).catch(() => alive && setPosts([]));
    return () => {
      alive = false;
    };
  }, [profile]);

  if (!posts) return null;
  return (
    <section className="save-history my-feedback">
      <h2>{t("fb.mine.title")}</h2>
      <p className="hint">{t("fb.mine.help")}</p>
      {posts.length === 0 ? (
        <p className="hint">{t("fb.mine.empty")} <Link to="/feedback">{t("nav.tokiFeedback")}</Link></p>
      ) : (
        <ul>
          {posts.map((p) => (
            <li key={p.id}>
              <span className="my-fb-main">
                <Link to={`/feedback/${p.id}`}>{p.title}</Link>
                <span className="sub">{p.game?.title ?? "Toki"} · {ago(p.updated_at, lang)}</span>
              </span>
              <span className="my-fb-tags">
                {p.reply_count > 0 && <span className="fb-replies"><ChatIcon />{p.reply_count}</span>}
                <KindTag kind={p.kind} />
                <StatusBadge kind={p.kind} status={p.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
