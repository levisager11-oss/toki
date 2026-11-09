import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import { refreshBadges, useBadges } from "../lib/useBadges";
import { clearNotifications, listNotifications, markNotificationsRead, type Notification } from "../lib/social";
import { Avatar } from "../components/Avatar";
import { useTitle } from "../lib/useTitle";

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
        return { line: t("notif.scoreBeaten", { who, title: d.title ?? "" }), to: g ? `/game/${g.slug}#scores` : "/" };
      }
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
    </section>
  );
}
