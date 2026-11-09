import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { findGame } from "../lib/games";
import { deleteRelease, groupReleases, listReleases, nextSmallVersion, nextVersion, type Release } from "../lib/releases";
import { ReleaseCard } from "../components/ReleaseCard";
import { ReleaseForm } from "../components/ReleaseForm";
import { useTitle } from "../lib/useTitle";

/** Release notes of one game (/game/:slug/updates) or of Toki itself (/updates). */
export function Releases() {
  const { slug } = useParams();
  const { t } = useI18n();
  const { profile } = useAuth();
  const { games, error: gamesError } = useGames();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const game = slug ? findGame(games, slug) : undefined;
  const gameId = slug ? game?.id : null; // undefined while loading
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const writing = params.get("new") === "1";
  const manager = !!profile && (profile.role === "admin" || (!!game && game.created_by === profile.id));
  const target = location.hash.startsWith("#r-") ? location.hash.slice(3) : "";

  useEffect(() => {
    if (gameId === undefined) return;
    let alive = true;
    listReleases(gameId)
      .then((r) => alive && setReleases(r))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [gameId, reload]);

  // Links like "Fixed in 1.2" point at one update: scroll to it once the list is there.
  useEffect(() => {
    if (releases && target) document.getElementById(`r-${target}`)?.scrollIntoView({ block: "start" });
  }, [releases, target]);

  const title = game ? t("rel.title.game", { title: game.title }) : t("rel.title.toki");
  useTitle(title);

  const setWriting = (on: boolean) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (on) next.set("new", "1");
      else next.delete("new");
      return next;
    }, { replace: true });
  const saved = () => {
    setWriting(false);
    setEditing(null);
    setReload((n) => n + 1);
  };
  const remove = async (id: string) => {
    try {
      await deleteRelease(id);
      setReleases((r) => r?.filter((x) => x.id !== id) ?? null);
    } catch {
      setError(true);
    }
    setConfirmDelete(null);
  };

  if (gamesError || error) return <p className="msg">{t("error")}</p>;
  if (slug && games && !game)
    return (
      <div className="msg">
        <p>{t("game.notFound")}</p>
        <Link to="/" className="btn">{t("back")}</Link>
      </div>
    );

  const card = (r: Release) =>
    editing === r.id ? (
      <ReleaseForm key={r.id} gameId={gameId ?? null} release={r} onSaved={saved} onCancel={() => setEditing(null)} />
    ) : (
      <ReleaseCard
        key={r.id}
        release={r}
        highlight={r.id === target}
        actions={manager && (
          <div className="actions rel-actions">
            <button type="button" className="btn" onClick={() => setEditing(r.id)}>{t("fb.post.edit")}</button>
            {confirmDelete === r.id ? (
              <>
                <button type="button" className="btn danger" onClick={() => remove(r.id)}>{t("fb.post.confirmDelete")}</button>
                <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>{t("form.cancel")}</button>
              </>
            ) : (
              <button type="button" className="btn ghost-danger" onClick={() => setConfirmDelete(r.id)}>{t("rel.delete")}</button>
            )}
          </div>
        )}
      />
    );

  return (
    <section className="fb-board rel-page">
      {slug && <Link to={`/game/${slug}`} className="back">← {t("fb.backToGame")}</Link>}
      <h1 className="h">{title}</h1>
      <p className="lead">{game ? t("rel.lead.game", { title: game.title }) : t("rel.lead.toki")}</p>

      {manager && releases && (writing ? (
        <ReleaseForm gameId={gameId ?? null} suggestedVersion={nextVersion(releases.find((r) => !r.small)?.version)} suggestedSmallVersion={nextSmallVersion(releases)} onSaved={saved} onCancel={() => setWriting(false)} />
      ) : (
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setWriting(true)}>{t("rel.new")}</button>
        </div>
      ))}

      {!releases ? (
        <div className="rel skel" aria-busy="true" aria-label={t("loading")}><span className="bar" style={{ width: "20%" }} /><span className="bar big" /><span className="bar" style={{ width: "70%" }} /></div>
      ) : releases.length === 0 ? (
        <p className="msg fb-empty">{t(manager ? "rel.emptyDev" : "rel.empty")}</p>
      ) : (
        <div className="rel-list">
          {groupReleases(releases).map((g) => (
            <div key={(g.main ?? g.small[0]).id} className="rel-group">
              {g.main && card(g.main)}
              {g.small.length > 0 && (
                <div className="rel-smalls">
                  <h2 className="label">{t(g.main ? "rel.smallSince" : "rel.smallOnly", { v: g.main?.version ?? "" })}</h2>
                  {g.small.map(card)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
