import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { AiSetup } from "../components/AiSetup";
import { AiFeaturesCard } from "../components/AiFeaturesCard";
import {
  developersWithQuotas, getAiFeatures, getAiSettings, monthOverview, recentUsage, saveAiSettings, setQuota, usd, OUTPUT_LIMITS, STARTER_CAP, STARTER_QUOTA,
  type AiFeature, type Overview, type UsageRow,
} from "../lib/ai";
import { useTitle } from "../lib/useTitle";

type Form = { enabled: boolean; base_url: string; monthly_cap: string; default_quota: string; max_output_tokens: number; agent_enabled: boolean; agent_budget: string };

/** Admins: AI settings, a Claude model per feature, this month's spending against the cap, and quotas per developer (/admin/ai). */
export function AiAdmin() {
  const { t, lang } = useI18n();
  useTitle(t("ai.title"));
  const [form, setForm] = useState<Form | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [devs, setDevs] = useState<{ id: string; username: string; quota: number | null }[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [error, setError] = useState(false);
  // The month card alone shows a problem loading the spending, so the form stays usable.
  const [overviewError, setOverviewError] = useState(false);
  const [saved, setSaved] = useState<Form | null>(null);
  const [saveMsg, setSaveMsg] = useState<"" | "saved" | "error">("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  // A feature with a model, for the test call after "Turn on AI" (the cheapest kind first).
  const [firstFeature, setFirstFeature] = useState<AiFeature | null>(null);
  useEffect(() => {
    getAiFeatures()
      .then((list) => {
        const on = list.filter((f) => f.model);
        setFirstFeature((on.find((f) => f.feature === "translate") ?? on[0])?.feature ?? null);
      })
      .catch(() => {});
  }, [reload]);

  useEffect(() => {
    getAiSettings()
      .then((s) => {
        const f: Form = {
          enabled: s.enabled,
          base_url: s.base_url,
          monthly_cap: String(s.monthly_cap),
          default_quota: String(s.default_quota),
          max_output_tokens: s.max_output_tokens ?? 32000,
          agent_enabled: s.agent_enabled ?? false,
          agent_budget: String(s.agent_budget ?? 1),
        };
        setForm(f);
        setSaved(f);
      })
      .catch(() => setError(true));
  }, []);
  useEffect(() => {
    monthOverview()
      .then((o) => {
        setOverview(o);
        setOverviewError(false);
      })
      .catch(() => setOverviewError(true));
    developersWithQuotas().then(setDevs).catch(() => {});
    recentUsage().then(setUsage).catch(() => {});
  }, [reload]);

  if (error) return <p className="msg">{t("error")}</p>;
  if (!form) return <p className="msg" aria-busy="true">{t("loading")}</p>;

  const cap = Number(form.monthly_cap) || 0;
  const defaultQuota = Number(form.default_quota) || 0;
  const spent = overview?.spent ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === "enabled" || k === "agent_enabled" ? e.target.checked : e.target.value });

  const toChange = (f: Form) => ({
    enabled: f.enabled,
    base_url: f.base_url.trim(),
    monthly_cap: Number(f.monthly_cap) || 0,
    default_quota: Number(f.default_quota) || 0,
    max_output_tokens: f.max_output_tokens,
    agent_enabled: f.agent_enabled,
    agent_budget: Math.min(50, Math.max(0.1, Number(f.agent_budget) || 1)),
  });

  // "Turn on AI" in the setup card: on, with starter limits where none are set yet. Settings
  // changed in the form but not saved yet stay as they were saved.
  const turnOn = async () => {
    const base = saved ?? form;
    const next: Form = {
      ...base,
      enabled: true,
      monthly_cap: Number(base.monthly_cap) > 0 ? base.monthly_cap : String(STARTER_CAP),
      default_quota: Number(base.default_quota) > 0 ? base.default_quota : String(STARTER_QUOTA),
    };
    await saveAiSettings(toChange(next));
    setSaved(next);
    setForm({ ...form, enabled: next.enabled, monthly_cap: next.monthly_cap, default_quota: next.default_quota });
    setReload((n) => n + 1);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveMsg("");
    const sent = form;
    try {
      await saveAiSettings(toChange(form));
      setSaveMsg("saved");
      setSaved(sent);
    } catch {
      setSaveMsg("error");
    }
    setBusy(false);
  };

  // Developers, plus anyone else (admins) who used the AI this month.
  const byUser = new Map((overview?.users ?? []).map((u) => [u.user_id, u]));
  const rows = [
    ...devs.map((d) => ({ id: d.id, username: d.username, admin: false, quota: d.quota, spent: byUser.get(d.id)?.spent ?? 0, calls: byUser.get(d.id)?.calls ?? 0 })),
    ...(overview?.users ?? [])
      .filter((u) => !devs.some((d) => d.id === u.user_id))
      .map((u) => ({ id: u.user_id, username: u.username, admin: u.role === "admin", quota: null, spent: u.spent, calls: u.calls })),
  ].sort((a, b) => b.spent - a.spent || (a.username ?? "").localeCompare(b.username ?? ""));

  return (
    <section className="fb-board ai-admin">
      <h1 className="h">{t("ai.title")}</h1>
      <p className="lead">{t("ai.lead")}</p>

      <section className="ai-card" aria-labelledby="ai-month-h">
        <h2 id="ai-month-h">{t("ai.month")}</h2>
        {overviewError && <p className="error" role="alert">{t("error")}</p>}
        <p className="ai-big">{t("ai.spent", { spent: usd(spent), cap: usd(cap) })}</p>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("ai.month")}>
          <i className={pct >= 80 ? "warn" : ""} style={{ width: `${pct}%` }} />
        </div>
        <p className="sub">
          {t("ai.calls", { n: overview?.calls ?? 0 })}
          {overview && overview.reserved > 0 ? ` · ${t("ai.reserved", { amount: usd(overview.reserved) })}` : ""}
        </p>
        <p className="hint">{t("ai.capNote")}</p>
      </section>

      <AiSetup
        ai={saved ? { enabled: saved.enabled, cap: Number(saved.monthly_cap) || 0, quota: Number(saved.default_quota) || 0, firstFeature } : null}
        onTurnOn={turnOn}
      />

      <form className="form ai-card" onSubmit={save} aria-labelledby="ai-settings-h">
        <h2 id="ai-settings-h">{t("ai.settings")}</h2>
        <p className="hint">{t("ai.strongLead")}</p>
        <label className="fb-check">
          <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
          <span>{t("ai.enabled")}</span>
        </label>
        <small>{t("ai.enabledHelp")}</small>
        <label htmlFor="ai-url">{t("ai.baseUrl")}</label>
        <input id="ai-url" type="url" placeholder="https://api.anthropic.com" maxLength={300} value={form.base_url} onChange={set("base_url")} aria-describedby="ai-url-help" />
        <small id="ai-url-help">{t("ai.baseUrlAnthropicHelp")}</small>
        <label htmlFor="ai-max-out">{t("ai.maxOutput")}</label>
        <select id="ai-max-out" value={form.max_output_tokens} onChange={(e) => setForm({ ...form, max_output_tokens: Number(e.target.value) })} aria-describedby="ai-max-out-help">
          {OUTPUT_LIMITS.map((v) => <option key={v} value={v}>{`${v / 1000}k`}</option>)}
        </select>
        <small id="ai-max-out-help">{t("ai.maxOutputHelp")}</small>
        <div className="ai-panel">
            <label className="fb-check">
              <input type="checkbox" checked={form.agent_enabled} onChange={set("agent_enabled")} />
              <span><b>{t("ai.agent.enabled")}</b></span>
            </label>
            <small>{t("ai.agent.help")}</small>
            <label htmlFor="ai-agent-budget">{t("ai.agent.budget")}</label>
            <input id="ai-agent-budget" type="number" min="0.1" max="50" step="0.1" inputMode="decimal" value={form.agent_budget} onChange={set("agent_budget")} aria-describedby="ai-agent-budget-help" />
            <small id="ai-agent-budget-help">{t("ai.agent.budgetHelp")}</small>
        </div>
        <div className="pair">
          <div>
            <label htmlFor="ai-cap">{t("ai.cap")}</label>
            <input id="ai-cap" type="number" min="0" max="1000" step="0.01" inputMode="decimal" value={form.monthly_cap} onChange={set("monthly_cap")} />
          </div>
          <div>
            <label htmlFor="ai-quota">{t("ai.defaultQuota")}</label>
            <input id="ai-quota" type="number" min="0" max="1000" step="0.01" inputMode="decimal" value={form.default_quota} onChange={set("default_quota")} />
          </div>
        </div>
        <small>{t("ai.quotaHelp")}</small>
        {saveMsg === "saved" && <p className="check good" role="status">{t("ai.saved")}</p>}
        {saveMsg === "error" && <p className="error" role="alert">{t("ai.saveError")}</p>}
        <div className="actions fb-form-actions">
          <button className="btn primary" disabled={busy}>{t("ai.save")}</button>
        </div>
      </form>

      <AiFeaturesCard baseUrl={saved?.base_url ?? ""} aiOn={!!saved?.enabled} onChanged={() => setReload((n) => n + 1)} />

      <section className="ai-card" aria-labelledby="ai-devs-h">
        <h2 id="ai-devs-h">{t("ai.developers")}</h2>
        <p className="hint">{t("ai.developersHelp")}</p>
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr><th>{t("ai.col.who")}</th><th>{t("ai.col.spent")}</th><th>{t("ai.col.calls")}</th><th>{t("ai.col.quota")}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id ?? "deleted"}>
                  <td>{r.username ? `@${r.username}` : t("ai.deleted")}</td>
                  <td className="num">{usd(r.spent)}</td>
                  <td className="num">{r.calls}</td>
                  <td>
                    {r.admin || !r.id ? (
                      <span className="sub">{t("ai.noQuota")}</span>
                    ) : (
                      <QuotaInput userId={r.id} quota={r.quota} placeholder={t("ai.quotaDefault", { amount: usd(defaultQuota) })} label={`${t("ai.col.quota")}: @${r.username}`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ai-card" aria-labelledby="ai-recent-h">
        <h2 id="ai-recent-h">{t("ai.recent")}</h2>
        {usage.length === 0 ? (
          <p className="hint">{t("ai.noCalls")}</p>
        ) : (
          <ul className="ai-log">
            {usage.map((u) => (
              <li key={u.id}>
                <span>{u.user ? `@${u.user.username}` : t("ai.deleted")} · {t(`ai.feature.${u.feature}`)} · {ago(u.created_at, lang)}</span>
                <span className="sub">{t("ai.tokens", { n: u.input_tokens + u.output_tokens })} · {t(`ai.callStatus.${u.status}`)}</span>
                <b className="num">{usd(u.cost)}</b>
                {u.error && <small className="model-error-detail ai-log-error">{u.error}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

/** A developer's quota: empty means the default. Saved when leaving the field. */
function QuotaInput({ userId, quota, placeholder, label }: { userId: string; quota: number | null; placeholder: string; label: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(quota === null ? "" : String(quota));
  const [state, setState] = useState<"" | "saved" | "error">("");
  // What's in the database now (the list isn't loaded again after a save).
  const stored = useRef(quota);
  const commit = async () => {
    const next = value.trim() === "" ? null : Math.max(0, Number(value));
    if (next === stored.current || (next !== null && Number.isNaN(next))) return;
    try {
      await setQuota(userId, next);
      stored.current = next;
      setState("saved");
    } catch {
      setState("error");
    }
  };
  return (
    <span className="quota-input">
      <input type="number" min="0" max="1000" step="0.01" inputMode="decimal" value={value} placeholder={placeholder} aria-label={label}
        onChange={(e) => { setValue(e.target.value); setState(""); }} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
      {state === "saved" && <span className="ok" role="status"><span aria-hidden="true">✓</span><span className="sr-only">{t("ai.saved")}</span></span>}
      {state === "error" && <span className="error" role="alert"><span aria-hidden="true">!</span><span className="sr-only">{t("error")}</span></span>}
    </span>
  );
}
