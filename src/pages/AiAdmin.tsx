import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import {
  aiStatus, developersWithQuotas, getAiSettings, monthOverview, recentUsage, saveAiSettings, setQuota, testAi, usd,
  type AiStatus, type Overview, type TestResult, type UsageRow,
} from "../lib/ai";

type Form = { enabled: boolean; base_url: string; model: string; input_price: string; output_price: string; monthly_cap: string; default_quota: string };

/** Admins: AI settings, this month's spending against the cap, and quotas per developer (/admin/ai). */
export function AiAdmin() {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<AiStatus | "unknown" | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [devs, setDevs] = useState<{ id: string; username: string; quota: number | null }[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [error, setError] = useState(false);
  const [saveMsg, setSaveMsg] = useState<"" | "saved" | "error">("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | "running" | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    getAiSettings()
      .then((s) =>
        setForm({
          enabled: s.enabled,
          base_url: s.base_url,
          model: s.model,
          input_price: String(s.input_price || ""),
          output_price: String(s.output_price || ""),
          monthly_cap: String(s.monthly_cap),
          default_quota: String(s.default_quota),
        }),
      )
      .catch(() => setError(true));
    aiStatus().then(setStatus).catch(() => setStatus("unknown"));
  }, []);
  useEffect(() => {
    monthOverview().then(setOverview).catch(() => setError(true));
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
    setForm({ ...form, [k]: k === "enabled" ? e.target.checked : e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveMsg("");
    try {
      await saveAiSettings({
        enabled: form.enabled,
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        input_price: Number(form.input_price) || 0,
        output_price: Number(form.output_price) || 0,
        monthly_cap: cap,
        default_quota: defaultQuota,
      });
      setSaveMsg("saved");
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
      setTest({ ok: false, message: e instanceof Error ? e.message : "" });
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

  const statusRow = (ok: boolean | undefined, label: string) => (
    <li>
      <span className={`st ${ok ? "st-done" : "st-declined"}`}>{ok ? t("ai.status.set") : t("ai.status.missing")}</span> {label}
    </li>
  );

  return (
    <section className="fb-board ai-admin">
      <h1 className="h">{t("ai.title")}</h1>
      <p className="lead">{t("ai.lead")}</p>

      <section className="ai-card" aria-labelledby="ai-month-h">
        <h2 id="ai-month-h">{t("ai.month")}</h2>
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

      <section className="ai-card" aria-labelledby="ai-setup-h">
        <h2 id="ai-setup-h">{t("ai.setup")}</h2>
        {status === "unknown" ? (
          <p className="check warn">{t("ai.status.unknown")}</p>
        ) : status ? (
          <ul className="ai-status">
            {statusRow(status.aiKey, t("ai.status.aiKey"))}
            {statusRow(status.serviceKey, t("ai.status.serviceKey"))}
            {statusRow(status.github, t("ai.status.github"))}
          </ul>
        ) : (
          <p className="hint">{t("loading")}</p>
        )}
        <p className="hint">{t("ai.status.help")}</p>
      </section>

      <form className="form ai-card" onSubmit={save} aria-labelledby="ai-settings-h">
        <h2 id="ai-settings-h">{t("ai.settings")}</h2>
        <label className="fb-check">
          <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
          <span>{t("ai.enabled")}</span>
        </label>
        <small>{t("ai.enabledHelp")}</small>
        <label htmlFor="ai-provider">{t("ai.provider")}</label>
        <select id="ai-provider" value="openai_compatible" disabled>
          <option value="openai_compatible">{t("ai.providerOpenai")}</option>
        </select>
        <small>{t("ai.providerLater")}</small>
        <label htmlFor="ai-url">{t("ai.baseUrl")}</label>
        <input id="ai-url" type="url" placeholder="https://" maxLength={300} value={form.base_url} onChange={set("base_url")} aria-describedby="ai-url-help" />
        <small id="ai-url-help">{t("ai.baseUrlHelp")}</small>
        <label htmlFor="ai-model">{t("ai.model")}</label>
        <input id="ai-model" maxLength={100} value={form.model} onChange={set("model")} autoComplete="off" spellCheck={false} />
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
          <button type="button" className="btn" onClick={runTest} disabled={test === "running"}>{test === "running" ? t("ai.testing") : t("ai.test")}</button>
        </div>
        {test && test !== "running" && (
          <div className={`check ${test.ok ? "good" : "warn"}`} role="status">
            <p>
              {test.ok
                ? t("ai.testOk", { text: test.text ?? "", input: test.inputTokens ?? 0, output: test.outputTokens ?? 0, cost: usd(test.cost ?? 0) })
                : t("ai.testFailed", { message: test.message || test.error || "" })}
            </p>
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
                <span className="sub">{u.input_tokens + u.output_tokens} tokens · {t(`ai.callStatus.${u.status}`)}</span>
                <b className="num">{usd(u.cost)}</b>
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
  const [value, setValue] = useState(quota === null ? "" : String(quota));
  const [state, setState] = useState<"" | "saved" | "error">("");
  const commit = async () => {
    const next = value.trim() === "" ? null : Math.max(0, Number(value));
    if (next === quota || (next !== null && Number.isNaN(next))) return;
    try {
      await setQuota(userId, next);
      setState("saved");
    } catch {
      setState("error");
    }
  };
  return (
    <span className="quota-input">
      <input type="number" min="0" max="1000" step="0.01" inputMode="decimal" value={value} placeholder={placeholder} aria-label={label}
        onChange={(e) => { setValue(e.target.value); setState(""); }} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
      {state === "saved" && <span className="ok" aria-label="✓">✓</span>}
      {state === "error" && <span className="error" role="alert">!</span>}
    </span>
  );
}
