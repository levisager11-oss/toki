import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { AiSetup } from "../components/AiSetup";
import { ModelPicker } from "../components/ModelPicker";
import { FreeAiCard } from "../components/FreeAiCard";
import {
  ApiError, connectError, developersWithQuotas, getAiSettings, monthOverview, recentUsage, saveAiSettings, setQuota, testAi, usd,
  THINKING, type AiSettings, type Overview, type Provider, type TestResult, type Thinking, type UsageRow,
} from "../lib/ai";
import { useTitle } from "../lib/useTitle";

type Form = { enabled: boolean; provider: Provider; base_url: string; model: string; input_price: string; output_price: string; monthly_cap: string; default_quota: string; thinking: Thinking; agent_enabled: boolean; agent_budget: string };

/** Admins: AI settings, this month's spending against the cap, and quotas per developer (/admin/ai). */
export function AiAdmin() {
  const { t, lang } = useI18n();
  useTitle(t("ai.title"));
  const [form, setForm] = useState<Form | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [devs, setDevs] = useState<{ id: string; username: string; quota: number | null }[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [error, setError] = useState(false);
  // The month card alone shows a problem loading the spending, so the form stays usable.
  const [overviewError, setOverviewError] = useState(false);
  // The form as last loaded or saved: the test uses the saved settings, so it waits until changes are saved.
  const [savedForm, setSavedForm] = useState("");
  const [saveMsg, setSaveMsg] = useState<"" | "saved" | "error">("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | "running" | null>(null);
  const [reload, setReload] = useState(0);
  // The model whose prices the endpoint filled in, to remind the admin to check them.
  const [pricesFrom, setPricesFrom] = useState("");

  useEffect(() => {
    getAiSettings()
      .then((s) => {
        setSettings(s);
        const f: Form = {
          enabled: s.enabled,
          provider: s.provider,
          base_url: s.base_url,
          model: s.model,
          input_price: String(s.input_price || ""),
          output_price: String(s.output_price || ""),
          monthly_cap: String(s.monthly_cap),
          default_quota: String(s.default_quota),
          thinking: s.thinking ?? "default",
          agent_enabled: s.agent_enabled ?? false,
          agent_budget: String(s.agent_budget ?? 1),
        };
        setForm(f);
        setSavedForm(JSON.stringify(f));
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
  const dirty = JSON.stringify(form) !== savedForm;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === "enabled" || k === "agent_enabled" ? e.target.checked : e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveMsg("");
    const sent = JSON.stringify(form);
    try {
      await saveAiSettings({
        enabled: form.enabled,
        provider: form.provider,
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        input_price: Number(form.input_price) || 0,
        output_price: Number(form.output_price) || 0,
        monthly_cap: cap,
        default_quota: defaultQuota,
        // Anthropic can't turn thinking off; "off" means the least there.
        thinking: form.provider === "anthropic" && form.thinking === "off" ? "low" : form.thinking,
        // Managed Agents only work with Anthropic.
        agent_enabled: form.provider === "anthropic" && form.agent_enabled,
        agent_budget: Math.min(50, Math.max(0.1, Number(form.agent_budget) || 1)),
      });
      setSaveMsg("saved");
      setSavedForm(sent);
    } catch {
      setSaveMsg("error");
    }
    setBusy(false);
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await testAi());
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : "", message: e instanceof ApiError ? e.detail : "" });
    }
    setReload((n) => n + 1);
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

      <AiSetup provider={form.provider} />

      {settings && <FreeAiCard settings={settings} />}

      <form className="form ai-card" onSubmit={save} aria-labelledby="ai-settings-h">
        <h2 id="ai-settings-h">{t("ai.settings")}</h2>
        <p className="hint">{t("ai.strongLead")}</p>
        <label className="fb-check">
          <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
          <span>{t("ai.enabled")}</span>
        </label>
        <small>{t("ai.enabledHelp")}</small>
        <label htmlFor="ai-provider">{t("ai.provider")}</label>
        <select
          id="ai-provider"
          value={form.provider}
          onChange={(e) => { setForm({ ...form, provider: e.target.value as Provider }); setPricesFrom(""); }}
          aria-describedby="ai-provider-help"
        >
          <option value="openai_compatible">{t("ai.providerOpenai")}</option>
          <option value="anthropic">{t("ai.providerAnthropic")}</option>
        </select>
        <small id="ai-provider-help">{t("ai.providerHelp")}</small>
        <label htmlFor="ai-url">{t("ai.baseUrl")}</label>
        <input
          id="ai-url"
          type="url"
          placeholder={form.provider === "anthropic" ? "https://api.anthropic.com" : "https://"}
          maxLength={300}
          value={form.base_url}
          onChange={set("base_url")}
          aria-describedby="ai-url-help"
        />
        <small id="ai-url-help">{t(form.provider === "anthropic" ? "ai.baseUrlAnthropicHelp" : "ai.baseUrlHelp")}</small>
        <label htmlFor="ai-model">{t("ai.model")}</label>
        <input id="ai-model" maxLength={100} value={form.model} onChange={(e) => { set("model")(e); setPricesFrom(""); }} autoComplete="off" spellCheck={false} />
        <ModelPicker
          // A new list for another address, so models and prices from the old one can't be picked.
          key={`${form.provider}|${form.base_url.trim()}`}
          provider={form.provider}
          baseUrl={form.base_url}
          selected={form.model}
          onPick={(m) => {
            const known = m.inputPrice !== undefined && m.outputPrice !== undefined;
            setForm({ ...form, model: m.id, ...(known ? { input_price: String(m.inputPrice), output_price: String(m.outputPrice) } : {}) });
            setPricesFrom(known ? m.id : "");
          }}
        />
        <div className="pair">
          <div>
            <label htmlFor="ai-in">{t("ai.inputPrice")}</label>
            <input id="ai-in" type="number" min="0" max="1000" step="0.0001" inputMode="decimal" value={form.input_price} onChange={set("input_price")} />
          </div>
          <div>
            <label htmlFor="ai-out">{t("ai.outputPrice")}</label>
            <input id="ai-out" type="number" min="0" max="1000" step="0.0001" inputMode="decimal" value={form.output_price} onChange={set("output_price")} />
          </div>
        </div>
        <small>{t("ai.priceHelp")}</small>
        <label htmlFor="ai-thinking">{t("ai.free.thinking")}</label>
        <select id="ai-thinking" value={form.thinking} onChange={(e) => setForm({ ...form, thinking: e.target.value as Thinking })} aria-describedby="ai-thinking-help">
          {THINKING.filter((v) => !(form.provider === "anthropic" && v === "off")).map((v) => <option key={v} value={v}>{t(`ai.free.thinking.${v}`)}</option>)}
        </select>
        <small id="ai-thinking-help">{t(form.provider === "anthropic" ? "ai.thinkingHelpAnthropic" : "ai.thinkingHelp")}</small>
        {form.provider === "anthropic" && (
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
        )}
        {pricesFrom && <p className="check" role="status">{t("ai.models.pricesFilled", { model: pricesFrom })}</p>}
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
          <button type="button" className="btn" onClick={runTest} disabled={test === "running" || dirty} aria-describedby={dirty ? "ai-test-hint" : undefined}>
            {test === "running" ? t("ai.testing") : t("ai.test")}
          </button>
        </div>
        {dirty && <small id="ai-test-hint">{t("ai.testSaveFirst")}</small>}
        {test && test !== "running" && (
          <div className={`check ${test.ok ? "good" : "warn"}`} role="status">
            <p>
              {test.ok
                ? t("ai.testOk", { text: test.text ?? "", input: test.inputTokens ?? 0, output: test.outputTokens ?? 0, cost: usd(test.cost ?? 0) })
                : t("ai.testFailed", { message: t(`connect.err.${connectError(test.error)}`) })}
            </p>
            {!test.ok && test.message && <span className="model-error-detail">{test.message}</span>}
            {test.ok && test.estimated && <p className="sub">{t("ai.testEstimated")}</p>}
          </div>
        )}
      </form>

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
