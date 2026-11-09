import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import {
  answerFriendRequest, blockUser, formatScore, getProfile, isOnline, openDm, playerScores, removeFriend,
  sendFriendRequest, SocialError, unblockUser, type ProfilePage,
} from "../lib/social";
import { Avatar } from "../components/Avatar";
import { GameGrid, GridSkeleton } from "../components/GameCard";
import { Cover } from "../components/Cover";
import type { Game } from "../lib/types";
import { NotFound } from "./NotFound";

/** A player's page: /u/:username */
export function Profile() {
  const { username = "" } = useParams();
  const { t, lang } = useI18n();
  const { session, ready } = useAuth();
  const { games } = useGames();
  const navigate = useNavigate();
  const location = useLocation();
  const [p, setP] = useState<ProfilePage | null | undefined>(undefined);
  const [scores, setScores] = useState<{ game_id: string; score: number; rank: number; players: number }[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const userId = session?.user.id;

  // Another player's page: don't show the last one's details while this one loads.
  useEffect(() => {
    setP(undefined);
    setScores([]);
    setErr("");
    setConfirmBlock(false);
  }, [username]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    getProfile(username)
      .then((r) => {
        if (!alive) return;
        setP(r);
        if (r) playerScores(r.id).then((s) => alive && setScores(s), () => {});
      })
      .catch(() => alive && setP(null));
    return () => {
      alive = false;
    };
  }, [username, ready, userId, reload]);

  useEffect(() => {
    if (p) document.title = `@${p.username} · Toki`;
    return () => {
      document.title = "Toki";
    };
  }, [p]);

  if (p === null) return <NotFound />;
  if (p === undefined || !games)
    return (
      <section className="profile" aria-busy="true">
        <div className="profile-head skel"><span className="avatar" style={{ width: 96, height: 96 }} /><span className="bar big" style={{ width: 200 }} /></div>
        <GridSkeleton count={4} />
      </section>
    );

  const byId = new Map(games.map((g) => [g.id, g]));
  const pick = (ids: string[] | undefined) => (ids ?? []).map((id) => byId.get(id)).filter((g): g is Game => !!g);
  const made = games.filter((g) => g.created_by === p.id);
  const liked = pick(p.likes);
  const recent = pick(p.recent);
  const playing = p.playing ? byId.get(p.playing) : undefined;
  const online = isOnline(p.last_seen);
  const login = `/login?next=${encodeURIComponent(location.pathname)}`;

  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
      setReload((n) => n + 1);
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    } finally {
      setBusy(false);
    }
  };
  const message = () => act(async () => navigate(`/chat/${await openDm(p.id)}`));

  return (
    <section className="profile">
      <div className="profile-head">
        <Avatar person={p} size={96} online={online} />
        <div className="profile-id">
          <h1 className="h">@{p.username}</h1>
          <span className="sub">
            {p.role !== "player" && <b className="role-badge">{t(p.role === "admin" ? "soc.role.admin" : "soc.role.dev")}</b>}
            {t("soc.joined", { date: new Date(p.created_at).toLocaleDateString(lang === "de" ? "de-CH" : "en", { month: "long", year: "numeric" }) })}
            {" · "}{t("soc.friendCount", { n: p.friend_count })}
          </span>
          {(p.relation === "friend" || p.relation === "self") && (
            <span className="sub presence">
              {playing ? (
                <>{t("soc.playingNow")} <Link to={`/game/${playing.slug}`}><b>{playing.title}</b></Link></>
              ) : online ? t("soc.online") : p.last_seen ? t("soc.lastSeen", { when: ago(p.last_seen, lang) }) : t("soc.offline")}
            </span>
          )}
          {p.bio && <p className="bio">{p.bio}</p>}
        </div>
        <div className="actions profile-actions">
          {p.relation === "self" && <Link to="/account" className="btn">{t("soc.editProfile")}</Link>}
          {p.relation === "guest" && <Link to={login} className="btn primary">{t("soc.loginToAdd")}</Link>}
          {p.relation === "none" && <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => sendFriendRequest(p.id))}>{t("soc.addFriend")}</button>}
          {p.relation === "sent" && <button type="button" className="btn" disabled={busy} onClick={() => act(() => removeFriend(p.id))}>{t("soc.cancelRequest")}</button>}
          {p.relation === "received" && (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => answerFriendRequest(p.id, true))}>{t("soc.accept")}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => act(() => answerFriendRequest(p.id, false))}>{t("soc.decline")}</button>
            </>
          )}
          {p.relation === "friend" && (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={message}>{t("soc.message")}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => act(() => removeFriend(p.id))}>{t("soc.unfriend")}</button>
            </>
          )}
          {p.relation === "blocked" && <button type="button" className="btn" disabled={busy} onClick={() => act(() => unblockUser(p.id))}>{t("soc.unblock")}</button>}
          {["none", "sent", "received", "friend"].includes(p.relation) && (
            confirmBlock ? (
              <button type="button" className="btn danger" disabled={busy} onClick={() => act(async () => { await blockUser(p.id); setConfirmBlock(false); })}>{t("soc.confirmBlock")}</button>
            ) : (
              <button type="button" className="btn ghost-danger" onClick={() => setConfirmBlock(true)}>{t("soc.block")}</button>
            )
          )}
        </div>
      </div>
      {confirmBlock && <p className="hint">{t("soc.blockHelp")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {p.relation === "self" && p.banned_until && new Date(p.banned_until) > new Date() && (
        <p className="check warn">{t("soc.bannedUntil", { date: new Date(p.banned_until).toLocaleString(lang === "de" ? "de-CH" : "en") })}</p>
      )}

      {made.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("soc.theirGames")}</h2></div>
          <GameGrid games={made} />
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("home.recent")}</h2></div>
          <GameGrid games={recent.slice(0, 8)} />
        </section>
      )}

      {scores.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("score.best")}</h2></div>
          <ul className="table scores">
            {scores.map((s) => {
              const g = byId.get(s.game_id);
              if (!g) return null;
              return (
                <li key={s.game_id}>
                  <Cover slug={g.slug} cover={g.cover} image={g.thumbnail_url} />
                  <div className="info">
                    <Link to={`/game/${g.slug}`} className="title">{g.title}</Link>
                    <span className="sub">{t("score.place", { rank: s.rank, n: s.players })}</span>
                  </div>
                  <b className="score">{formatScore(s.score, g.score_format, lang)}</b>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <div className="sechead"><h2>{t("nav.favorites")}</h2></div>
        {liked.length ? <GameGrid games={liked} /> : <p className="msg">{t("soc.noFavorites")}</p>}
      </section>
    </section>
  );
}
