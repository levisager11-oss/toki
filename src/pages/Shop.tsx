import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n, type Key } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { useTitle } from "../lib/useTitle";
import { ago } from "../lib/feedback";
import {
  adminSetCosmetic, buyCosmetic, cosmeticName, equipCosmetic, KINDS, loadCatalog, refreshLook, refreshProgress, shopErrorKey,
  useCatalog, useCollection, useLook, useMyProgress, WEAR_COLUMN, type Cosmetic, type CosmeticKind, type WearKind,
} from "../lib/cosmetics";
import { EARN, levelProgress } from "../lib/progress";
import { CosmeticTile } from "../components/Collection";
import { LevelBadge, Tokens } from "../components/Looks";

type Filter = CosmeticKind | "all" | "games";

/** The shop (/shop): Toki's cosmetics for tokens, the player's level, and how to earn more. */
export function Shop() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const location = useLocation();
  const { games } = useGames();
  const catalog = useCatalog();
  const me = useMyProgress(profile?.id);
  const look = useLook(profile?.id);
  const owned = useCollection(profile?.id);
  const [filter, setFilter] = useState<Filter>("all");
  const [sure, setSure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [got, setGot] = useState<string | null>(null);
  // A double-click must not go straight through "Sure?": the confirm click counts a moment later.
  const sureAt = useRef(0);
  const admin = profile?.role === "admin";
  useTitle(t("shop.title"));

  const person = profile ?? { id: "", username: t("shop.you") };
  const byId = new Map((games ?? []).map((g) => [g.id, g]));
  const all = catalog ? [...catalog.values()] : [];
  const toki = all.filter((c) => !c.game_id && (admin || (c.active && c.price !== null)));
  const gameOnes = all.filter((c) => c.game_id && c.active && byId.has(c.game_id));
  const shown = filter === "games" ? gameOnes : toki.filter((c) => filter === "all" || c.kind === filter);
  const lv = me ? levelProgress(me.xp) : null;
  const login = `/login?next=${encodeURIComponent(location.pathname)}`;

  const wearing = (c: Cosmetic) => c.kind !== "stickers" && look?.[WEAR_COLUMN[c.kind as WearKind]] === c.id;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    }
    setBusy(false);
  };
  const buy = (c: Cosmetic) => act(async () => {
    if (sure !== c.id) {
      sureAt.current = Date.now();
      return setSure(c.id);
    }
    if (Date.now() - sureAt.current < 400) return;
    setSure(null);
    await buyCosmetic(c.id);
    setGot(c.id);
    owned.reload();
    // The purchase is done: a failing refresh is no error, the numbers catch up later.
    void refreshProgress(profile?.id, true);
  });
  const wear = (c: Cosmetic) => act(async () => {
    if (c.kind === "stickers" || !profile) return;
    await equipCosmetic(c.kind, wearing(c) ? null : c.id);
    refreshLook(profile.id);
  });

  return (
    <section className="shop">
      <div className="shop-head">
        <div>
          <h1 className="h">{t("shop.title")}</h1>
          <p className="lead">{t("shop.lead")}</p>
        </div>
        {profile ? (
          <div className="shop-me">
            <Tokens n={me?.tokens} className="big" />
            {lv && (
              <div className="shop-level">
                <LevelBadge level={lv.level} big />
                <span className="lv-bar" aria-hidden="true"><i style={{ width: `${lv.share * 100}%` }} /></span>
                <span className="sub">{t("lv.toNext", { n: lv.needed - lv.into })}</span>
              </div>
            )}
            <span className="shop-links">
              <Link to="/trades">{t("trade.title")}</Link>
              <Link to="/top">{t("top.title")}</Link>
            </span>
          </div>
        ) : (
          <div className="shop-me"><Link to={login} className="btn primary">{t("shop.login")}</Link></div>
        )}
      </div>

      <details className="earn">
        <summary>{t("shop.earn.title")}</summary>
        <ul>
          <li>{t("shop.earn.play", { n: EARN.playXpPerDay })}</li>
          <li>{t("shop.earn.achievement", { xp: EARN.achievementXp, n: EARN.achievementTokens, max: EARN.achievementTokensPerDay })}</li>
          <li>{t("shop.earn.score", { xp: EARN.bestScoreXp, max: EARN.bestScoreXpPerDay })}</li>
          <li>{t("shop.earn.daily", { xp: EARN.dailyXp, n: EARN.dailyTokens, max: EARN.dailyTokens + EARN.streakBonusMax })}</li>
          <li>{t("shop.earn.level", { n: EARN.levelTokens })}</li>
          <li>{t("shop.earn.cap", { n: EARN.xpPerDay })}</li>
        </ul>
        <p className="sub">{t("shop.earn.noMoney")}</p>
      </details>

      <div className="chips" role="group" aria-label={t("shop.filter")}>
        {(["all", ...KINDS, "games"] as Filter[]).map((f) => (
          <button key={f} type="button" className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => { setFilter(f); setGot(null); setSure(null); }}>
            {t(f === "all" ? "shop.all" : f === "games" ? "shop.fromGames" : (`shop.kinds.${f}` as Key))}
          </button>
        ))}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {got && catalog?.get(got) && (
        <p className="check good" role="status">
          {t("shop.got", { name: cosmeticName(catalog.get(got)!, lang) })}{" "}
          {catalog.get(got)!.kind === "stickers" ? t("shop.gotStickers") : ""}
        </p>
      )}

      {!catalog ? (
        <p className="msg">{t("loading")}</p>
      ) : filter === "games" && !gameOnes.length ? (
        <p className="msg">{t("shop.noGameOnes")}</p>
      ) : (
        <ul className="cos-grid">
          {shown.map((c) => {
            const has = !!owned.ids?.has(c.id);
            const locked = !!lv && lv.level < c.min_level;
            const broke = me ? me.tokens < (c.price ?? 0) : true;
            const game = c.game_id ? byId.get(c.game_id) : undefined;
            return (
              <CosmeticTile key={c.id} c={c} person={person} games={byId} on={wearing(c)}>
                {c.game_id ? (
                  has ? <span className="sub">{t("shop.youHave")}</span>
                    : <span className="sub">{t("shop.byAchievement")} {game && <Link to={`/game/${game.slug}#achievements`}>{game.title}</Link>}</span>
                ) : has ? (
                  c.kind === "stickers"
                    ? <span className="sub">{t("shop.youHave")}</span>
                    : <button type="button" className={`btn small${wearing(c) ? "" : " primary"}`} aria-pressed={wearing(c)} disabled={busy} onClick={() => wear(c)}>{t(wearing(c) ? "shop.takeOff" : "shop.wear")}</button>
                ) : c.price === null || !c.active ? (
                  <span className="sub">{t("shop.notSold")}</span>
                ) : (
                  <span className="cos-buy">
                    <Tokens n={c.price} />
                    {!profile ? null : locked ? (
                      <span className="sub">{t("shop.fromLevel", { n: c.min_level })}</span>
                    ) : (
                      <>
                        <button type="button" className={`btn small${sure === c.id ? " primary" : ""}`} disabled={busy || broke} title={broke ? t("shop.needTokens") : undefined} aria-describedby={broke ? `why-${c.id}` : undefined} onClick={() => buy(c)}>
                          {sure === c.id ? t("shop.buySure") : t("shop.buy")}
                        </button>
                        {broke && <span id={`why-${c.id}`} className="sr-only">{t("shop.needTokens")}</span>}
                      </>
                    )}
                  </span>
                )}
                {admin && !c.game_id && <AdminPrice c={c} />}
              </CosmeticTile>
            );
          })}
        </ul>
      )}

      {me && me.log.length > 0 && (
        <section>
          <div className="sechead"><h2>{t("shop.history")}</h2></div>
          <ul className="token-log">
            {me.log.map((l, i) => (
              <li key={i}>
                <b className={l.amount < 0 ? "neg" : "pos"}>{l.amount > 0 ? "+" : ""}{l.amount}</b>{" "}
                {t(`shop.why.${l.reason}` as Key, { level: l.data.level ?? "", name: l.data.cosmetic && catalog?.get(l.data.cosmetic) ? cosmeticName(catalog.get(l.data.cosmetic)!, lang) : "" })}{" "}
                <time className="sub" dateTime={l.at}>{ago(l.at, lang)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="note">{t("shop.note")}</p>
    </section>
  );
}

/** Admins: the price of one of Toki's cosmetics, and whether it is sold. */
function AdminPrice({ c }: { c: Cosmetic }) {
  const { t } = useI18n();
  const [price, setPrice] = useState(String(c.price ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setPrice(String(c.price ?? ""));
  }, [c.price]);
  const save = async (active: boolean) => {
    const p = Number.parseInt(price, 10);
    if (!(p > 0)) return setErr(t("shop.admin.badPrice"));
    setBusy(true);
    setErr("");
    try {
      await adminSetCosmetic(c.id, p, active);
      await loadCatalog(true);
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    }
    setBusy(false);
  };
  return (
    <form className="row-form admin-price" onSubmit={(e) => { e.preventDefault(); void save(c.active); }}>
      <label className="sr-only" htmlFor={`price-${c.id}`}>{t("shop.admin.price")}</label>
      <input id={`price-${c.id}`} type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} />
      <button type="submit" className="btn small" disabled={busy}>{t("shop.admin.save")}</button>
      <button type="button" className="btn small" disabled={busy} onClick={() => save(!c.active)}>{t(c.active ? "shop.admin.stop" : "shop.admin.start")}</button>
      {err && <span className="error" role="alert">{err}</span>}
    </form>
  );
}
