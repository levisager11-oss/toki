import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n, type Key } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import {
  adminLimits, findAccount, setKeepTime, setLimit, setLimitOverride,
  type AdminLimits, type KeepRow, type LimitKey, type LimitRow,
} from "../lib/limits";

/** Admins: every limit for players and developers, accounts with their own, and deletion times (/admin/limits). */
export function LimitsAdmin() {
  const { t } = useI18n();
  useTitle(t("nav.limits"));
  const [data, setData] = useState<AdminLimits | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    adminLimits().then((d) => alive && setData(d), () => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [reload]);

  if (failed) return <section className="fb-board"><p className="error" role="alert">{t("error")}</p></section>;
  if (!data) return <section className="fb-board"><p className="hint">{t("loading")}</p></section>;

  // Limits come in groups of ten (sort 10–19: ideas, 20–29: feedback, ...).
  const groups = new Map<number, LimitRow[]>();
  for (const l of data.limits) groups.set(Math.floor(l.sort / 10), [...(groups.get(Math.floor(l.sort / 10)) ?? []), l]);

  return (
    <section className="fb-board ai-admin">
      <h1 className="h">{t("nav.limits")}</h1>
      <p className="lead">{t("lim.lead")}</p>

      <section className="ai-card" aria-labelledby="lim-h">
        <h2 id="lim-h">{t("lim.limits")}</h2>
        <p className="hint">{t("lim.limitsHelp")}</p>
        <div className="ai-table-wrap">
          <table className="ai-table limit-table">
            <thead>
              <tr><th>{t("lim.col.what")}</th><th>{t("lim.col.players")}</th><th>{t("lim.col.devs")}</th></tr>
            </thead>
            {[...groups].map(([g, rows]) => (
              <tbody key={g}>
                <tr className="limit-group"><th colSpan={3} scope="colgroup">{t(`lim.group.${g}` as Key)}</th></tr>
                {rows.map((r) => <LimitLine key={r.key} row={r} />)}
              </tbody>
            ))}
          </table>
        </div>
      </section>

      <Overrides data={data} onChange={() => setReload((n) => n + 1)} />

      <section className="ai-card" aria-labelledby="keep-h">
        <h2 id="keep-h">{t("lim.keep")}</h2>
        <p className="hint">{t("lim.keepHelp")}</p>
        <div className="ai-table-wrap">
          <table className="ai-table limit-table">
            <thead>
              <tr><th>{t("lim.col.what")}</th><th>{t("lim.col.keep")}</th></tr>
            </thead>
            <tbody>
              {data.keep.map((k) => <KeepLine key={k.key} row={k} />)}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

/** "Game ideas a day"; the AI limits use the features' names. */
export function limitLabel(t: ReturnType<typeof useI18n>["t"], key: LimitKey): string {
  // Each key has its text (tests/limits.test.ts checks).
  return t((key.startsWith("ai_") ? `ai.feature.${key.slice(3)}` : `lim.k.${key}`) as Key);
}

function LimitLine({ row }: { row: LimitRow }) {
  const { t } = useI18n();
  const [r, setR] = useState(row);
  const label = limitLabel(t, row.key);
  const save = async (player: number, creator: number) => {
    await setLimit(r.key, player, creator);
    setR({ ...r, player, creator });
  };
  const range = t("lim.range", { min: r.min_value, max: r.max_value });
  return (
    <tr>
      <td className="what">
        {label}
        {r.who === "everyone" && <span className="sub"> · {t("lim.everyone")}</span>}
      </td>
      {r.who === "everyone" ? (
        <td colSpan={2}><NumberCell value={r.player} min={r.min_value} max={r.max_value} label={label} title={range} save={(v) => save(v, v)} /></td>
      ) : (
        <>
          <td>
            {r.who === "creator"
              ? <span className="sub">{t("lim.devsOnly")}</span>
              : <NumberCell value={r.player} min={r.min_value} max={r.max_value} label={`${label}: ${t("lim.col.players")}`} title={range} save={(v) => save(v, r.who === "player" ? v : r.creator)} />}
          </td>
          <td>
            {r.who === "player"
              ? <span className="sub">{t("lim.playersOnly")}</span>
              : <NumberCell value={r.creator} min={r.min_value} max={r.max_value} label={`${label}: ${t("lim.col.devs")}`} title={range} save={(v) => save(r.who === "creator" ? v : r.player, v)} />}
          </td>
        </>
      )}
    </tr>
  );
}

function KeepLine({ row }: { row: KeepRow }) {
  const { t } = useI18n();
  const label = t(`lim.keep.${row.key}` as Key);
  return (
    <tr>
      <td className="what">{label}</td>
      <td>
        <NumberCell value={row.value} min={row.min_value} max={row.max_value} label={label} title={t("lim.range", { min: row.min_value, max: row.max_value })}
          unit={t(row.unit === "days" ? "lim.unit.days" : "lim.unit.count")} save={(v) => setKeepTime(row.key, v)} />
      </td>
    </tr>
  );
}

/** A whole number, saved when leaving the field; out of range goes back to what's saved. */
function NumberCell({ value, min, max, label, title, unit, save }: {
  value: number; min: number; max: number; label: string; title: string; unit?: string; save: (v: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));
  const [state, setState] = useState<"" | "saved" | "error" | "range">("");
  const stored = useRef(value);
  const commit = async () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isInteger(v) || v < min || v > max) {
      setText(String(stored.current));
      if (text.trim() !== String(stored.current)) setState("range");
      return;
    }
    if (v === stored.current) return;
    try {
      await save(v);
      stored.current = v;
      setState("saved");
    } catch {
      setState("error");
    }
  };
  return (
    <span className="quota-input limit-input">
      <input type="number" min={min} max={max} step="1" inputMode="numeric" value={text} aria-label={label} title={title}
        onChange={(e) => { setText(e.target.value); setState(""); }} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
      {unit && <span className="sub">{unit}</span>}
      {state === "saved" && <span className="ok" role="status"><span aria-hidden="true">✓</span><span className="sr-only">{t("ai.saved")}</span></span>}
      {state === "error" && <span className="error" role="alert"><span aria-hidden="true">!</span><span className="sr-only">{t("error")}</span></span>}
      {state === "range" && <span className="error" role="alert">{title}</span>}
    </span>
  );
}

/** Accounts with their own value for a limit. */
function Overrides({ data, onChange }: { data: AdminLimits; onChange: () => void }) {
  const { t } = useI18n();
  const choices = data.limits.filter((l) => l.who !== "everyone");
  const [name, setName] = useState("");
  const [key, setKey] = useState<LimitKey>(choices[0]?.key ?? "ideas_day");
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = choices.find((l) => l.key === key);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    const v = Number(value);
    if (value.trim() === "" || !Number.isInteger(v) || v < chosen.min_value || v > chosen.max_value) {
      return setErr(t("lim.range", { min: chosen.min_value, max: chosen.max_value }));
    }
    setBusy(true);
    setErr("");
    try {
      const account = await findAccount(name);
      if (!account) {
        setErr(t("lim.own.noAccount"));
      } else if (account.role === "admin") {
        setErr(t("lim.own.admin"));
      } else {
        await setLimitOverride(account.id, key, v);
        setName("");
        setValue("");
        onChange();
      }
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
  };
  const remove = async (userId: string, k: LimitKey) => {
    try {
      await setLimitOverride(userId, k, null);
      onChange();
    } catch {
      setErr(t("error"));
    }
  };
  const usual = (l: LimitRow) => (l.who === "creator" ? l.creator : l.who === "player" ? l.player : null);

  return (
    <section className="ai-card" aria-labelledby="lim-own-h">
      <h2 id="lim-own-h">{t("lim.own")}</h2>
      <p className="hint">{t("lim.ownHelp")}</p>
      {data.overrides.length > 0 && (
        <div className="ai-table-wrap">
          <table className="ai-table limit-table">
            <thead>
              <tr><th>{t("lim.col.account")}</th><th>{t("lim.col.what")}</th><th>{t("lim.col.value")}</th><th><span className="sr-only">{t("lim.own.remove")}</span></th></tr>
            </thead>
            <tbody>
              {data.overrides.map((o) => {
                const l = data.limits.find((x) => x.key === o.key);
                return (
                  <tr key={`${o.user_id}-${o.key}`}>
                    <td>@{o.username}</td>
                    <td className="what">{limitLabel(t, o.key)}</td>
                    <td className="num">
                      {o.value}
                      {l && <span className="sub"> ({t("lim.own.usual", { n: o.role === "creator" ? l.creator : l.player })})</span>}
                    </td>
                    <td><button type="button" className="btn ghost-danger" onClick={() => remove(o.user_id, o.key)}>{t("lim.own.remove")}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form className="form limit-own-form" onSubmit={add}>
        <div className="pair">
          <div>
            <label htmlFor="lim-own-name">{t("lim.own.name")}</label>
            <input id="lim-own-name" value={name} required autoCapitalize="none" spellCheck={false} placeholder="@username" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="lim-own-key">{t("lim.col.what")}</label>
            <select id="lim-own-key" value={key} onChange={(e) => setKey(e.target.value as LimitKey)}>
              {choices.map((l) => <option key={l.key} value={l.key}>{l.key.startsWith("ai_") ? `${t("lim.group.6")}: ` : ""}{limitLabel(t, l.key)}</option>)}
            </select>
          </div>
        </div>
        <label htmlFor="lim-own-value">{t("lim.col.value")}</label>
        <input id="lim-own-value" type="number" min={chosen?.min_value ?? 0} max={chosen?.max_value} step="1" inputMode="numeric" required value={value}
          placeholder={chosen && usual(chosen) !== null ? String(usual(chosen)) : undefined} onChange={(e) => setValue(e.target.value)} />
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="btn primary" disabled={busy}>{t("lim.own.add")}</button>
      </form>
    </section>
  );
}
