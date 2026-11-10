import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import {
  answerFriendRequest, findPlayers, isOnline, myBlocks, myFriends, openDm, removeFriend, sendFriendRequest,
  SocialError, unblockUser, type FriendRow, type Person,
} from "../lib/social";
import { useAuth } from "../lib/auth";
import { Avatar } from "../components/Avatar";
import { useTitle } from "../lib/useTitle";
import { InviteToGame } from "../components/GameInvite";

export function Friends() {
  const { t, lang } = useI18n();
  useTitle(t("soc.friends"));
  const { profile } = useAuth();
  const { games } = useGames();
  const navigate = useNavigate();
  const [rows, setRows] = useState<FriendRow[] | null>(null);
  const [blocked, setBlocked] = useState<Person[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  // The search the list belongs to, so "nobody found" only shows for a finished search.
  const [foundFor, setFoundFor] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    myFriends().then((r) => alive && setRows(r), () => alive && setErr(t("error")));
    myBlocks().then((b) => alive && setBlocked(b), () => {});
    return () => {
      alive = false;
    };
  }, [reload, t]);

  useEffect(() => {
    // An older, slower search must not replace the results of a newer one.
    let alive = true;
    const id = setTimeout(() => findPlayers(q).then((f) => alive && (setFound(f), setFoundFor(q)), () => alive && setFound([])), 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q]);
  const searched = q.trim().replace(/^@/, "").length >= 2 && foundFor === q;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(id);
    try {
      await fn();
      setReload((n) => n + 1);
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    } finally {
      setBusy(null);
    }
  };

  const gameTitle = (id: string | null) => (id ? games?.find((g) => g.id === id) : undefined);
  const friends = rows?.filter((r) => r.status === "friend") ?? [];
  const received = rows?.filter((r) => r.status === "received") ?? [];
  const sent = rows?.filter((r) => r.status === "sent") ?? [];
  const known = new Map((rows ?? []).map((r) => [r.id, r.status]));
  const online = friends.filter((f) => isOnline(f.last_seen)).length;

  return (
    <section className="panel friends">
      <div className="sechead">
        <h1 className="h">{t("soc.friends")}</h1>
        <Link to="/chat" className="btn">{t("nav.chat")}</Link>
      </div>
      {err && <p className="error" role="alert">{err}</p>}

      <form className="form find" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="find">{t("soc.findPlayers")}</label>
        <input id="find" value={q} onChange={(e) => setQ(e.target.value)} placeholder="@username" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </form>
      {searched && found.filter((p) => p.id !== profile?.id).length === 0 && <p className="hint">{t("soc.nobodyFound")}</p>}
      {found.length > 0 && (
        <ul className="people">
          {found.filter((p) => p.id !== profile?.id).map((p) => {
            const status = known.get(p.id);
            return (
              <li key={p.id}>
                <Link to={`/u/${p.username}`} className="person"><Avatar person={p} /><b>@{p.username}</b></Link>
                {status === "friend" ? <span className="sub">{t("soc.isFriend")}</span>
                  : status === "sent" ? <span className="sub">{t("soc.requestSent")}</span>
                  : status === "received" ? <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => answerFriendRequest(p.id, true))}>{t("soc.accept")}</button>
                  : <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => sendFriendRequest(p.id))}>{t("soc.addFriend")}</button>}
              </li>
            );
          })}
        </ul>
      )}

      {received.length > 0 && (
        <>
          <h2>{t("soc.requests")} <span className="count-pill">{received.length}</span></h2>
          <ul className="people">
            {received.map((p) => (
              <li key={p.id}>
                <Link to={`/u/${p.username}`} className="person"><Avatar person={p} /><b>@{p.username}</b></Link>
                <div className="actions">
                  <button type="button" className="btn primary" disabled={busy === p.id} onClick={() => act(p.id, () => answerFriendRequest(p.id, true))}>{t("soc.accept")}</button>
                  <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => answerFriendRequest(p.id, false))}>{t("soc.decline")}</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>{t("soc.yourFriends")} {friends.length > 0 && <span className="sub">{t("soc.onlineCount", { n: online })}</span>}</h2>
      {rows === null ? (
        <p className="msg">{t("loading")}</p>
      ) : friends.length === 0 ? (
        <p className="msg">{t("soc.noFriends")}</p>
      ) : (
        <ul className="people">
          {friends.map((f) => {
            const on = isOnline(f.last_seen);
            const g = gameTitle(f.playing);
            return (
              <li key={f.id}>
                <Link to={`/u/${f.username}`} className="person">
                  <Avatar person={f} online={on} />
                  <span>
                    <b>@{f.username}</b>
                    <span className="sub">
                      {g ? <>{t("soc.playingNow")} {g.title}</> : on ? t("soc.online") : f.last_seen ? t("soc.lastSeen", { when: ago(f.last_seen, lang) }) : t("soc.offline")}
                    </span>
                  </span>
                </Link>
                <div className="actions">
                  {g && <Link to={`/game/${g.slug}`} className="btn">{t("soc.join")}</Link>}
                  {on && <InviteToGame friend={f} />}
                  <button type="button" className="btn" disabled={busy === f.id} onClick={() => act(f.id, async () => navigate(`/chat/${await openDm(f.id)}`))}>{t("soc.message")}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {sent.length > 0 && (
        <>
          <h2>{t("soc.sentRequests")}</h2>
          <ul className="people">
            {sent.map((p) => (
              <li key={p.id}>
                <Link to={`/u/${p.username}`} className="person"><Avatar person={p} /><b>@{p.username}</b></Link>
                <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => removeFriend(p.id))}>{t("soc.cancelRequest")}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {blocked.length > 0 && (
        <details className="blocked">
          <summary>{t("soc.blocked", { n: blocked.length })}</summary>
          <ul className="people">
            {blocked.map((p) => (
              <li key={p.id}>
                <span className="person"><Avatar person={p} /><b>@{p.username}</b></span>
                <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => unblockUser(p.id))}>{t("soc.unblock")}</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
