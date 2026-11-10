import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { IDEA_STATUSES, listIdeas, type GameIdea, type IdeaStatus } from "../lib/ideas";
import { canCreate } from "../lib/types";
import { useTitle } from "../lib/useTitle";
import { IdeaForm, IdeaMeta } from "../components/IdeaBits";
import { ListSkeleton } from "../components/FeedbackBits";

type Filter = IdeaStatus | "mine" | "all";
const FILTERS: Filter[] = [...IDEA_STATUSES, "mine", "all"];

/**
 * Game ideas (/ideas). Developers see every idea, to discuss and claim; everyone else sees
 * the ideas they proposed and what became of them.
 */
export function Ideas() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dev = canCreate(profile);
  const me = profile?.id;
  const [ideas, setIdeas] = useState<GameIdea[] | null>(null);
  const [error, setError] = useState(false);
  const writing = params.get("new") === "1";
  const shown = params.get("show");
  const filter: Filter = (FILTERS as string[]).includes(shown ?? "") ? (shown as Filter) : "open";

  const set = (key: string, value?: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    let alive = true;
    listIdeas().then((list) => alive && setIdeas(list), () => alive && setError(true));
    return () => {
      alive = false;
    };
    // Again when the account changes: what it may see changes.
  }, [me, dev]);

  useTitle(t("idea.title"));

  // Players only have their own few ideas: no filter needed.
  const list = !ideas ? null : !dev ? ideas : ideas.filter((i) =>
    filter === "all" ? true : filter === "mine" ? i.author_id === me || i.claimed_by === me : i.status === filter);
  const count = (f: Filter) => (ideas ?? []).filter((i) => (f === "mine" ? i.author_id === me || i.claimed_by === me : i.status === f)).length;

  return (
    <section className="fb-board">
      <h1 className="h">{t(dev ? "idea.title" : "idea.mine")}</h1>
      <p className="lead">{t(dev ? "idea.lead.dev" : "idea.lead.player")}</p>

      {writing ? (
        <IdeaForm onCancel={() => set("new")} onDone={(idea) => navigate(`/ideas/${idea.id}`, { state: { sent: true } })} />
      ) : (
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => set("new", "1")}>{t("idea.propose")}</button>
        </div>
      )}

      {dev && (
        <div className="fb-tools">
          <div className="chips" role="group" aria-label={t("idea.filter")}>
            {FILTERS.map((f) => (
              <button key={f} type="button" className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => set("show", f === "open" ? undefined : f)}>
                {t(`idea.filter.${f}`)}{ideas && f !== "all" && count(f) > 0 ? ` (${count(f)})` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <p className="msg">{t("error")}</p>
      ) : !list ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <p className="msg fb-empty">{t(!dev ? "idea.empty.player" : filter === "open" ? "idea.empty.open" : "idea.empty")}</p>
      ) : (
        <ul className="fb-list">
          {list.map((i) => (
            <li className="fb-row" key={i.id}>
              <div className="fb-main">
                <Link to={`/ideas/${i.id}`} className="fb-title">{i.title}</Link>
                <IdeaMeta idea={i} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="note">{t("idea.kept")}</p>
    </section>
  );
}
