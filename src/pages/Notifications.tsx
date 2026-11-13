import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n, type Key } from "../lib/i18n";
import { gameUpdate, updateKeys } from "../lib/gameUpdates";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import { refreshBadges, useBadges } from "../lib/useBadges";
import { clearNotifications, listNotifications, markNotificationsRead, type Notification } from "../lib/social";
import { Avatar } from "../components/Avatar";
import { useTitle } from "../lib/useTitle";
import { INVITE_MS, joinPath } from "../lib/invites";
import { PushSwitch } from "../components/PushSwitch";

export function Notifications() {
  const { t, lang } = useI18n();
  const { games } = useGames();
  const { notifications: unread } = useBadges();
  const [list, setList] = useState<Notification[] | null>(null);
  const [err, setErr] = useState(false);
  const hasNew = unread > 0;

  // Loads again when a new one arrives while the page is open.
  useEffect(() => {
    let alive = true;
    listNotifications().then(
      (n) => {
        if (!alive) return;
        setList(n);
        // Seen now: the bell goes back to 0, the list still shows which ones are new.
        if (n.some((x) => !x.read_at)) markNotificationsRead().then(refreshBadges, () => {});
      },
      () => alive && setErr(true),
    );
    return () => {
      alive = false;
    };
  }, [hasNew]);

  useTitle(t("nav.notifications"));

  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    if (!confirmClear) return setConfirmClear(true);
    setClearing(true);
    try {
      await clearNotifications();
      setList([]);
      refreshBadges();
    } catch {
      setErr(true);
    }
    setClearing(false);
    setConfirmClear(false);
  };

  const text = (n: Notification): { line: string; to: string } => {
    const who = n.actor ? `@${n.actor.username}` : "Toki";
    const d = n.data;
    switch (n.kind) {
      case "fb_reply":
        return { line: t(d.official ? "notif.devReply" : "notif.reply", { who, title: d.title ?? "" }), to: `/feedback/${d.post}` };
      case "fb_status":
        return {
          line: d.version && d.status === "done" ? t("notif.fixed", { title: d.title ?? "", v: d.version }) : t("notif.status", { title: d.title ?? "", status: t(`fb.status.${(d.status ?? "open") as "open"}`) }),
          to: `/feedback/${d.post}`,
        };
      case "friend_request":
        return { line: t("notif.friendRequest", { who }), to: "/friends" };
      case "friend_accept":
        return { line: t("notif.friendAccept", { who }), to: n.actor ? `/u/${n.actor.username}` : "/friends" };
      case "group_add":
        return { line: t("notif.groupAdd", { who, title: d.title ?? "" }), to: `/chat/${d.chat}` };
      case "score_beaten": {
        const g = games?.find((x) => x.id === d.game);
        // On one of the game's other boards: its name too.
        const board = d.board ? (lang === "de" && d.board_name_de) || d.board_name || d.board : "";
        return {
          line: board ? t("boards.notif", { who, title: d.title ?? "", board }) : t("notif.scoreBeaten", { who, title: d.title ?? "" }),
          to: g ? `/game/${g.slug}#scores` : "/",
        };
      }
      case "game_invite": {
        const g = games?.find((x) => x.id === d.game);
        // The room may be gone after a while (and its code used by someone else): then just the game.
        const fresh = Date.now() - new Date(n.created_at).getTime() < INVITE_MS;
        return {
          line: t(fresh ? "notif.gameInvite" : "notif.gameInviteOld", { who, title: g?.title ?? d.title ?? "" }),
          to: g ? (fresh && d.code ? joinPath(g.slug, d.code, d.party) : `/game/${g.slug}`) : "/",
        };
      }
      case "game_idea": {
        const title = d.title ?? "";
        const to = `/ideas/${d.idea}`;
        if (d.event === "new") return { line: t("notif.ideaNew", { who, title }), to };
        if (d.event === "claimed") return { line: t("notif.ideaClaimed", { who, title }), to };
        if (d.event === "released") return { line: t("notif.ideaReleased", { title }), to };
        if (d.event === "done") return { line: t("notif.ideaDone", { who, title }), to };
        return { line: t("notif.ideaReply", { who, title }), to };
      }
      case "dev_news":
        // An update for their games (src/lib/gameUpdates.ts) leads to its card, with the one-click update.
        if (gameUpdate(d.topic)) return { line: t(updateKeys(d.topic!).notif as Key), to: `/my-games#update-${d.topic}` };
        return { line: t(d.topic === "multiplayer" ? "notif.devMultiplayer" : "notif.devNews"), to: "/my-games#toki-features" };
      case "moderation": {
        // What was removed, the admin's reason, a ban if there is one, and how to object.
        const why = d.note ? ` ${t("mod.why", { note: d.note })}` : "";
        const ban = d.days ? ` ${t("mod.banned", { n: d.days })}` : "";
        return { line: `${t(`mod.removed.${d.what ?? "message"}`, { title: d.title ?? "" })}${why}${ban} ${t("mod.appeal")}`, to: "/imprint" };
      }
      case "report_done":
        return {
          line: `${t(`mod.report.${d.what ?? "message"}`, { title: d.title ?? "" })} ${t(d.outcome === "dismissed" ? "mod.reportKept" : "mod.reportRemoved")}`,
          to: "/terms",
        };
      case "application":
        return d.event === "answer"
          ? { line: t("notif.appAnswer", { who }), to: "/applications" }
          : { line: t("notif.appQuestion"), to: "/apply" };
      default:
        // A kind this version of Toki doesn't know yet.
        return { line: t("notif.other"), to: "/updates" };
    }
  };

  return (
    <section className="panel notifications">
      <div className="sechead">
        <h1 className="h">{t("nav.notifications")}</h1>
        {!!list?.length && !err && (
          <div className="actions">
            {confirmClear && <button type="button" className="btn" onClick={() => setConfirmClear(false)}>{t("form.cancel")}</button>}
            <button type="button" className={`btn ${confirmClear ? "danger" : ""}`} onClick={clear} disabled={clearing}>{confirmClear ? t("notif.clearSure") : t("notif.clear")}</button>
          </div>
        )}
      </div>
      {err ? <p className="msg">{t("error")}</p> : list === null ? <p className="msg">{t("loading")}</p> : list.length === 0 ? (
        <p className="msg">{t("notif.empty")}</p>
      ) : (
        <ul className="notif-list">
          {list.map((n) => {
            const { line, to } = text(n);
            return (
              <li key={n.id} className={n.read_at ? "" : "new"}>
                <Link to={to}>
                  {n.actor ? <Avatar person={n.actor} /> : <span className="avatar room-icon" aria-hidden="true">!</span>}
                  <span>
                    <span className="line">{line}</span>
                    <time className="sub" dateTime={n.created_at}>{ago(n.created_at, lang)}</time>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="note">{t("notif.kept")}</p>
      <PushSwitch />
    </section>
  );
}
