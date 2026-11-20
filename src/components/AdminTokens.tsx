import { useEffect, useState } from "react";
import { adminAdjustTokens, adminProgress, adminTakeCosmetic, cosmeticName, refreshLook, useCatalog, type TokenChange } from "../lib/cosmetics";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { Tokens } from "./Looks";

/**
 * For admins, on a player's profile: their tokens and where they came from, to give or take
 * tokens, and to take away a cosmetic (e.g. one won by cheating). The terms allow this.
 */
export function AdminTokens({ userId, owned, onChange }: { userId: string; owned: Set<string> | null; onChange: () => void }) {
  const { t, lang } = useI18n();
  const catalog = useCatalog();
  const [info, setInfo] = useState<{ tokens: number; log: TokenChange[] } | null>(null);
  const [amount, setAmount] = useState("");
  const [take, setTake] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);

  useEffect(() => {
    let alive = true;
    adminProgress(userId).then((p) => alive && setInfo(p), () => {});
    return () => {
      alive = false;
    };
  }, [userId, n]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      setN((x) => x + 1);
      onChange();
      refreshLook(userId);
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
  };

  return (
    <details className="admin-tokens">
      <summary>{t("shop.admin.title")}</summary>
      <p className="sub">{t("shop.admin.lead")}</p>
      <p><Tokens n={info?.tokens} /></p>
      <form className="row-form" onSubmit={(e) => { e.preventDefault(); const v = Number.parseInt(amount, 10); if (v) void run(() => adminAdjustTokens(userId, v)).then(() => setAmount("")); }}>
        <label htmlFor="adm-tok" className="sr-only">{t("shop.admin.amount")}</label>
        <input id="adm-tok" type="number" step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-50" />
        <button type="submit" className="btn" disabled={busy || !amount}>{t("shop.admin.adjust")}</button>
      </form>
      {owned && owned.size > 0 && catalog && (
        <form className="row-form" onSubmit={(e) => { e.preventDefault(); if (take) void run(() => adminTakeCosmetic(userId, take)).then(() => setTake("")); }}>
          <label htmlFor="adm-take" className="sr-only">{t("shop.admin.take")}</label>
          <select id="adm-take" value={take} onChange={(e) => setTake(e.target.value)}>
            <option value="">{t("shop.admin.pick")}</option>
            {[...owned].map((id) => <option key={id} value={id}>{catalog.get(id) ? cosmeticName(catalog.get(id)!, lang) : id}</option>)}
          </select>
          <button type="submit" className="btn ghost-danger" disabled={busy || !take}>{t("shop.admin.take")}</button>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {!!info?.log.length && (
        <ul className="token-log">
          {info.log.map((l, i) => (
            <li key={i}><b className={l.amount < 0 ? "neg" : "pos"}>{l.amount > 0 ? "+" : ""}{l.amount}</b> {t(`shop.why.${l.reason}`)} <time className="sub">{ago(l.at, lang)}</time></li>
          ))}
        </ul>
      )}
    </details>
  );
}
