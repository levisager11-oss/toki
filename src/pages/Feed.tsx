import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n, type Key } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import { formatScore } from "../lib/social";
import { myFeed, type FeedItem } from "../lib/reviews";
import { cosmeticName, useCatalog } from "../lib/cosmetics";
import { Avatar } from "../components/Avatar";
import { LevelBadge, Name, Stars } from "../components/Looks";
import { CosmeticPreview } from "../components/Collection";

/** What friends did lately, and news from the developers the player follows (/feed). */
export function Feed() {
  const { t, lang } = useI18n();
  const { games } = useGames();
  const catalog = useCatalog();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [moreErr, setMoreErr] = useState(false);
  useTitle(t("feed.title"));

  useEffect(() => {
    let alive = true;
    myFeed().then((l) => {
      if (!alive) return;
      setItems(l);
      setMore(l.length >= 30);
    }, () => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, []);

  const loadMore = async () => {
    if (!items?.length) return;
    setBusy(true);
    setMoreErr(false);
    try {
      const next = await myFeed(items[items.length - 1].at);
      // The next page starts at the last timestamp, so an item can come twice: keep it once.
      const key = (i: FeedItem) => `${i.kind}|${i.at}|${i.user_id}|${i.game_id ?? ""}|${JSON.stringify(i.data)}`;
      const seen = new Set(items.map(key));
      setItems([...items, ...next.filter((i) => !seen.has(key(i)))]);
      setMore(next.length >= 30);
    } catch {
      setMoreErr(true);
    }
    setBusy(false);
  };

  const gameLink = (i: FeedItem, hash = "") =>
    i.game_slug ? <Link to={`/game/${i.game_slug}${hash}`}><b>{i.game_title}</b></Link> : <b>…</b>;

  const line = (i: FeedItem) => {
    const d = i.data;
    switch (i.kind) {
      case "level":
        return <>{t("feed.level")} <LevelBadge level={d.level} /></>;
      case "achievement":
        return <>{t((d.ids?.length ?? 1) > 1 ? "feed.achievements" : "feed.achievement", { n: d.ids?.length ?? 1 })} {gameLink(i, "#achievements")}</>;
      case "best": {
        const g = games?.find((x) => x.id === i.game_id);
        return <>{t("feed.best")} {gameLink(i, "#scores")}: <b>{formatScore(d.score ?? 0, g?.score_format, lang)}</b></>;
      }
      case "cosmetic": {
        const c = d.id ? catalog?.get(d.id) : undefined;
        if (!c) return <>{t("feed.cosmeticSome")}</>;
        return <>{t("feed.cosmetic", { kind: t(`shop.kind.${c.kind}` as Key) })} <b>{cosmeticName(c, lang)}</b>{c.game_id && <> · {gameLink(i)}</>}</>;
      }
      case "review":
        return <>{t("feed.review")} {gameLink(i, "#reviews")} <Stars value={d.stars ?? 0} /></>;
      case "new_game":
        return <>{t("feed.newGame")} {gameLink(i)}</>;
      case "release":
        return <>{t("feed.release", { v: d.version ?? "" })} {gameLink(i)}{d.title ? `: ${d.title}` : ""}</>;
      default:
        return null;
    }
  };

  return (
    <section className="panel feed">
      <h1 className="h">{t("feed.title")}</h1>
      <p className="lead">{t("feed.lead")}</p>
      {err ? <p className="msg">{t("error")}</p> : !items ? <p className="msg">{t("loading")}</p> : items.length === 0 ? (
        <div className="msg">
          <p>{t("feed.empty")}</p>
          <Link to="/friends" className="btn">{t("nav.friends")}</Link>
        </div>
      ) : (
        <ul className="feed-list">
          {items.map((i, n) => {
            const c = i.kind === "cosmetic" && i.data.id ? catalog?.get(i.data.id) : undefined;
            const person = { id: i.user_id, username: i.username, avatar_url: i.avatar_url, avatar_seed: i.avatar_seed };
            return (
              <li key={`${i.kind}-${i.at}-${n}`}>
                <Link to={`/u/${i.username}`} className="feed-who"><Avatar person={person} size={36} /></Link>
                <div className="feed-body">
                  <p><Link to={`/u/${i.username}`} className="person"><Name person={person} title={false} /></Link> {line(i)}</p>
                  <time className="sub" dateTime={i.at}>{ago(i.at, lang)}</time>
                </div>
                {c && <CosmeticPreview c={c} person={person} />}
              </li>
            );
          })}
        </ul>
      )}
      {moreErr && <p className="error" role="alert">{t("error")}</p>}
      {more && !err && <button type="button" className="btn" disabled={busy} onClick={loadMore}>{t("feed.more")}</button>}
      <p className="note">{t("feed.note")}</p>
    </section>
  );
}
