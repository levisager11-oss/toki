import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n, type Key } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { ago } from "../lib/feedback";
import { myFriends, type FriendRow } from "../lib/social";
import {
  answerTrade, cancelTrade, cosmeticName, myTrades, offerTrade, refreshLook, refreshProgress, shopErrorKey, tradingOpen,
  useCatalog, useCollection, useMyProgress, type Cosmetic, type Trade,
} from "../lib/cosmetics";
import { TERMS_CHANGES } from "../lib/terms";
import { Avatar } from "../components/Avatar";
import { Name, Tokens } from "../components/Looks";
import { CosmeticPreview } from "../components/Collection";

const opensOn = TERMS_CHANGES.find((c) => c.id === "tokens")!.date;

function useOpensText() {
  const { t, lang } = useI18n();
  const date = new Intl.DateTimeFormat(lang === "de" ? "de-CH" : "en-GB", { day: "numeric", month: "long" }).format(new Date(opensOn + "T12:00:00"));
  return t("trade.opens", { date });
}

/** Trades with friends (/trades): offers to answer, one's own offers, and the last 30 days. */
export function Trades() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const catalog = useCatalog();
  const opens = useOpensText();
  const [list, setList] = useState<Trade[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useTitle(t("trade.title"));

  useEffect(() => {
    let alive = true;
    myTrades().then((l) => {
      if (!alive) return;
      setList(l);
      setErr("");
    }, () => alive && setErr(t("error")));
    return () => {
      alive = false;
    };
  }, [n, t]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fn();
      if (r === "failed") setErr(t("trade.failed"));
      await refreshProgress(profile?.id, true);
      if (profile) refreshLook(profile.id);
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    } finally {
      setN((x) => x + 1);
      setBusy(false);
    }
  };

  const items = (ids: string[], tokens: number) => (
    <span className="trade-items">
      {tokens > 0 && <Tokens n={tokens} />}
      {ids.map((id) => <span key={id} className="trade-item">{catalog?.get(id) ? cosmeticName(catalog.get(id)!, lang) : id}</span>)}
    </span>
  );

  return (
    <section className="panel trades">
      <div className="sechead">
        <h1 className="h">{t("trade.title")}</h1>
        {tradingOpen() && <Link to="/trades/new" className="btn primary">{t("trade.new")}</Link>}
      </div>
      <p className="lead">{t("trade.lead")}</p>
      {!tradingOpen() && <p className="check">{opens}</p>}
      <p className="check warn">{t("trade.safety")}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {!list ? <p className="msg">{t("loading")}</p> : list.length === 0 ? <p className="msg">{t("trade.none")}</p> : (
        <ul className="trade-list">
          {list.map((tr) => {
            const open = tr.status === "open";
            const gift = tr.want_tokens === 0 && tr.want_items.length === 0;
            return (
              <li key={tr.id} className={open && !tr.mine ? "new" : ""}>
                <Link to={`/u/${tr.other_username}`} className="person">
                  <Avatar person={{ id: tr.other_id, username: tr.other_username, avatar_url: tr.other_avatar_url, avatar_seed: tr.other_avatar_seed }} size={28} />
                  <Name person={{ id: tr.other_id, username: tr.other_username }} title={false} />
                </Link>
                {gift ? (
                  <div className="trade-deal">
                    <span><span className="label">{t(tr.mine ? "trade.giftTo" : "trade.giftFrom", { who: `@${tr.other_username}` })}</span>{items(tr.give_items, tr.give_tokens)}</span>
                  </div>
                ) : (
                  <div className="trade-deal">
                    <span><span className="label">{t(tr.mine ? "trade.youGive" : "trade.youGet")}</span>{items(tr.give_items, tr.give_tokens)}</span>
                    <span><span className="label">{t(tr.mine ? "trade.youGet" : "trade.youGive")}</span>{items(tr.want_items, tr.want_tokens)}</span>
                  </div>
                )}
                <div className="trade-end">
                  <span className="sub">{t(`trade.status.${tr.status}` as Key)} · {ago(tr.answered_at ?? tr.created_at, lang)}</span>
                  {open && !tr.mine && (
                    <span className="actions">
                      <button type="button" className="btn small primary" disabled={busy || !tradingOpen()} onClick={() => act(() => answerTrade(tr.id, true))}>{t("trade.accept")}</button>
                      <button type="button" className="btn small" disabled={busy} onClick={() => act(() => answerTrade(tr.id, false))}>{t("trade.decline")}</button>
                      {tradingOpen() && <Link to={`/trades/new?with=${encodeURIComponent(tr.other_username)}&counter=${tr.id}`} className="btn small">{t("trade.counter")}</Link>}
                    </span>
                  )}
                  {open && tr.mine && <button type="button" className="btn small" disabled={busy} onClick={() => act(() => cancelTrade(tr.id))}>{t("trade.cancel")}</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="note">{t("trade.kept")}</p>
    </section>
  );
}

/** A new offer to a friend (/trades/new?with=username). */
export function NewTrade() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const catalog = useCatalog();
  const opens = useOpensText();
  const me = useMyProgress(profile?.id);
  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const withName = params.get("with") ?? "";
  const counterId = params.get("counter") ?? "";
  const [counter, setCounter] = useState<Trade | null>(null);
  const prefilled = useRef("");
  const friend = friends?.find((f) => f.username.toLowerCase() === withName.toLowerCase() && f.status === "friend");
  const mine = useCollection(profile?.id);
  const theirs = useCollection(friend?.id);
  const [give, setGive] = useState<Set<string>>(new Set());
  const [want, setWant] = useState<Set<string>>(new Set());
  const [giveTokens, setGiveTokens] = useState("");
  const [wantTokens, setWantTokens] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useTitle(t("trade.new"));

  useEffect(() => {
    myFriends().then((f) => setFriends(f.filter((x) => x.status === "friend")), () => setFriends([]));
  }, []);
  // A counter-offer: the open offer this answers, from this friend.
  useEffect(() => {
    if (!counterId) return setCounter(null);
    myTrades().then((l) => setCounter(l.find((x) => x.id === counterId && !x.mine && x.status === "open") ?? null), () => setCounter(null));
  }, [counterId]);
  const replyTo = counter && friend && counter.other_id === friend.id ? counter : null;
  useEffect(() => {
    setGive(new Set());
    setWant(new Set());
    prefilled.current = "";
  }, [friend?.id]);

  // Only Toki's own cosmetics can be traded, and only ones the other side doesn't have.
  const tradable = (ids: Set<string> | null, other: Set<string> | null) =>
    [...(ids ?? [])].map((id) => catalog?.get(id)).filter((c): c is Cosmetic => !!c && !c.game_id && !other?.has(c.id));
  const myItems = useMemo(() => tradable(mine.ids, theirs.ids), [mine.ids, theirs.ids, catalog]);
  const theirItems = useMemo(() => tradable(theirs.ids, mine.ids), [mine.ids, theirs.ids, catalog]);
  // The offer reversed: what they gave is what you want now, and the other way round.
  useEffect(() => {
    if (!replyTo || !mine.ids || !theirs.ids || !catalog || prefilled.current === replyTo.id) return;
    prefilled.current = replyTo.id;
    setGive(new Set(replyTo.want_items.filter((id) => myItems.some((c) => c.id === id))));
    setWant(new Set(replyTo.give_items.filter((id) => theirItems.some((c) => c.id === id))));
    setGiveTokens(replyTo.want_tokens > 0 ? String(Math.min(replyTo.want_tokens, me?.tokens ?? replyTo.want_tokens)) : "");
    setWantTokens(replyTo.give_tokens > 0 ? String(replyTo.give_tokens) : "");
  }, [replyTo, mine.ids, theirs.ids, catalog, myItems, theirItems, me?.tokens]);
  const gt = Math.max(0, Number.parseInt(giveTokens, 10) || 0);
  const wt = Math.max(0, Number.parseInt(wantTokens, 10) || 0);
  const ready = !!friend && (gt > 0 || give.size > 0) && gt <= (me?.tokens ?? 0);
  const gift = wt === 0 && want.size === 0;

  const toggle = (set: Set<string>, id: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else if (next.size < 10) next.add(id);
    put(next);
  };
  const send = async () => {
    if (!friend) return;
    setBusy(true);
    setErr("");
    try {
      await offerTrade(friend.id, gt, [...give], wt, [...want], replyTo?.id);
      navigate("/trades");
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    }
    setBusy(false);
  };

  const pickList = (list: Cosmetic[], set: Set<string>, put: (s: Set<string>) => void, person: { id: string; username: string }) =>
    list.length === 0 ? <p className="sub">{t("trade.nothing")}</p> : (
      <ul className="trade-pick">
        {list.map((c) => (
          <li key={c.id}>
            <label className={set.has(c.id) ? "on" : ""}>
              <input type="checkbox" checked={set.has(c.id)} onChange={() => toggle(set, c.id, put)} />
              <CosmeticPreview c={c} person={person} />
              <span>{cosmeticName(c, lang)}</span>
            </label>
          </li>
        ))}
      </ul>
    );

  if (!tradingOpen()) {
    return (
      <section className="panel trades">
        <h1 className="h">{t("trade.new")}</h1>
        <p className="check">{opens}</p>
        <p><Link to="/shop">{t("shop.title")}</Link></p>
      </section>
    );
  }

  return (
    <section className="panel trades">
      <h1 className="h">{t("trade.new")}</h1>
      <p className="check warn">{t("trade.safety")}</p>
      {replyTo && <p className="check">{t("trade.counterHint")}</p>}
      <div className="field">
        <label htmlFor="trade-with">{t("trade.with")}</label>
        <select id="trade-with" value={friend?.username ?? ""} onChange={(e) => setParams(e.target.value ? { with: e.target.value } : {}, { replace: true })}>
          <option value="">{t("trade.pickFriend")}</option>
          {(friends ?? []).map((f) => <option key={f.id} value={f.username}>@{f.username}</option>)}
        </select>
        {friends && friends.length === 0 && <p className="hint"><Link to="/friends">{t("top.addFriends")}</Link></p>}
      </div>
      {friend && profile && (
        <div className="trade-sides">
          <fieldset>
            <legend>{t("trade.youGive")}</legend>
            <label className="trade-tokens">
              <span><Tokens n={me?.tokens} /> {t("trade.have")}</span>
              <input type="number" min={0} max={me?.tokens ?? 0} value={giveTokens} onChange={(e) => setGiveTokens(e.target.value)} placeholder="0" />
            </label>
            {pickList(myItems, give, setGive, profile)}
          </fieldset>
          <fieldset>
            <legend>{t("trade.youGet")}</legend>
            <label className="trade-tokens">
              <span>{t("trade.tokensFrom", { who: `@${friend.username}` })}</span>
              <input type="number" min={0} value={wantTokens} onChange={(e) => setWantTokens(e.target.value)} placeholder="0" />
            </label>
            {pickList(theirItems, want, setWant, friend)}
          </fieldset>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        <Link to="/trades" className="btn">{t("form.cancel")}</Link>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={send}>{t(gift ? "trade.sendGift" : "trade.send")}</button>
      </div>
      {friend && <p className="hint">{t("trade.giftHint")}</p>}
      <p className="note">{t("trade.how")}</p>
    </section>
  );
}
