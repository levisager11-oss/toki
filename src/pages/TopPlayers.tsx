import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { topPlayers, type TopRow } from "../lib/cosmetics";
import { Avatar } from "../components/Avatar";
import { LevelBadge, Name } from "../components/Looks";

/** The players with the most XP (/top): everyone, or the player and their friends. */
export function TopPlayers() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const friends = params.get("show") === "friends" && !!profile;
  const [rows, setRows] = useState<TopRow[] | null>(null);
  const [err, setErr] = useState(false);
  useTitle(t("top.title"));

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErr(false);
    topPlayers(friends).then((r) => alive && setRows(r), () => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [friends, profile?.id]);

  const num = (n: number) => n.toLocaleString(lang === "de" ? "de-CH" : "en-GB");
  return (
    <section className="panel top-players">
      <h1 className="h">{t("top.title")}</h1>
      <p className="lead">{t("top.lead")}</p>
      {profile && (
        <div className="chips" role="group" aria-label={t("top.title")}>
          <button type="button" className={friends ? "" : "on"} aria-pressed={!friends} onClick={() => setParams({}, { replace: true })}>{t("top.everyone")}</button>
          <button type="button" className={friends ? "on" : ""} aria-pressed={friends} onClick={() => setParams({ show: "friends" }, { replace: true })}>{t("top.friends")}</button>
        </div>
      )}
      {err ? <p className="msg">{t("error")}</p> : !rows ? <p className="msg">{t("loading")}</p> : rows.length === 0 ? (
        <p className="msg">{t("top.empty")}</p>
      ) : (
        <ol className="board top-list">
          {rows.map((r) => (
            <li key={r.user_id} className={r.user_id === profile?.id ? "me" : ""}>
              <span className="rank">{r.rank}</span>
              <Link to={`/u/${r.username}`} className="person"><Avatar person={r} size={28} /><span className="who"><Name person={r} /></span></Link>
              <span className="top-lv"><LevelBadge level={r.level} /><span className="sub">{t("top.xp", { xp: num(r.xp) })}</span></span>
            </li>
          ))}
        </ol>
      )}
      {friends && rows && rows.length <= 1 && <p className="note"><Link to="/friends">{t("top.addFriends")}</Link></p>}
      <p className="note"><Link to="/shop">{t("top.howToEarn")}</Link></p>
    </section>
  );
}
