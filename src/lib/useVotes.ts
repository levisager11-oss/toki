import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { myVotes, setVote, type FeedbackPost } from "./feedback";

type SetPosts = (change: (posts: FeedbackPost[]) => FeedbackPost[]) => void;

/** The account's votes on these posts, and voting that shows at once and is undone if saving fails. */
export function useVotes(posts: FeedbackPost[] | null, setPosts: SetPosts) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [voted, setVoted] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const ids = posts?.map((p) => p.id).join(",") ?? "";

  useEffect(() => {
    if (!userId || !ids) {
      setVoted(new Set());
      return;
    }
    let alive = true;
    myVotes(ids.split(",")).then((v) => alive && setVoted(v));
    return () => {
      alive = false;
    };
  }, [userId, ids]);

  const apply = (id: string, on: boolean) => {
    setVoted((v) => {
      const next = new Set(v);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setPosts((list) => list.map((p) => (p.id === id ? { ...p, vote_count: Math.max(0, p.vote_count + (on ? 1 : -1)) } : p)));
  };

  const vote = async (post: FeedbackPost, on: boolean) => {
    if (pending.current.has(post.id) || voted.has(post.id) === on) return;
    pending.current.add(post.id);
    apply(post.id, on);
    try {
      await setVote(post.id, on);
    } catch {
      apply(post.id, !on);
    } finally {
      pending.current.delete(post.id);
    }
  };

  return { voted, vote };
}
