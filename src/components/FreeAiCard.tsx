import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { freeUsage, saveAiSettings, type AiSettings, type FreeUsage } from "../lib/ai";
import { assistError, testFreeAi, type FreeTest } from "../lib/assist";
import { ModelPicker } from "./ModelPicker";

type Form = { free_enabled: boolean; free_base_url: string; free_model: string; connect_free_steps: boolean };

/** Admins: the free AI (an endpoint where tokens cost nothing) and what it was used for. */
export function FreeAiCard({ settings }: { settings: AiSettings }) {
  const { t } = useI18n();
  const initial: Form = {
    free_enabled: settings.free_enabled,
    free_base_url: settings.free_base_url,
    free_model: settings.free_model,
    connect_free_steps: settings.connect_free_steps,
  };
  const [form, setForm] = useState<Form>(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [msg, setMsg] = useState<"" | "saved" | "error">("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<FreeTest | "running" | null>(null);
  const [usage, setUsage] = useState<FreeUsage[] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    freeUsage().then(setUsage).catch(() => setUsage([]));
  }, [reload]);
  const dirty = JSON.stringify(form) !== saved;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const next = { ...form, free_base_url: form.free_base_url.trim(), free_model: form.free_model.trim() };
    try {
      await saveAiSettings(next);
      setForm(next);
      setSaved(JSON.stringify(next));
      setMsg("saved");
    } catch {
      setMsg("error");
    }
    setBusy(false);
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await testFreeAi());
    } catch (e) {
      setTest({ ok: false, error: assistError(e) });
    }
    setReload((n) => n + 1);
  };

  return (
    <form className="form ai-card" onSubmit={save} aria-labelledby="free-ai-h">
      <h2 id="free-ai-h">{t("ai.free.title")}</h2>
      <p className="hint">{t("ai.free.lead")}</p>
      <label className="fb-check">
        <input type="checkbox" checked={form.free_enabled} onChange={(e) => setForm({ ...form, free_enabled: e.target.checked })} />
        <span>{t("ai.free.enabled")}</span>
      </label>
      <label htmlFor="free-url">{t("ai.baseUrl")}</label>
      <input id="free-url" type="url" placeholder="https://" maxLength={300} value={form.free_base_url} onChange={(e) => setForm({ ...form, free_base_url: e.target.value })} aria-describedby="free-url-help" />
      <small id="free-url-help">{t("ai.free.urlHelp")}</small>
      <label htmlFor="free-model">{t("ai.model")}</label>
      <input id="free-model" maxLength={100} value={form.free_model} onChange={(e) => setForm({ ...form, free_model: e.target.value })} autoComplete="off" spellCheck={false} />
      <ModelPicker key={form.free_base_url.trim()} provider="openai_compatible" baseUrl={form.free_base_url} selected={form.free_model} onPick={(m) => setForm({ ...form, free_model: m.id })} />
      <label className="fb-check">
        <input type="checkbox" checked={form.connect_free_steps} onChange={(e) => setForm({ ...form, connect_free_steps: e.target.checked })} />
        <span>{t("ai.free.connectSteps")}</span>
      </label>
      <small>{t("ai.free.connectStepsHelp")}</small>
      {msg === "saved" && <p className="check good" role="status">{t("ai.saved")}</p>}
      {msg === "error" && <p className="error" role="alert">{t("ai.free.saveError")}</p>}
      <div className="actions fb-form-actions">
        <button className="btn primary" disabled={busy}>{t("ai.save")}</button>
        <button type="button" className="btn" onClick={runTest} disabled={test === "running" || dirty}>{test === "running" ? t("ai.testing") : t("ai.test")}</button>
      </div>
      {dirty && <small>{t("ai.testSaveFirst")}</small>}
      {test && test !== "running" && (
        <div className={`check ${test.ok ? "good" : "warn"}`} role="status">
          <p>
            {test.ok
              ? t("ai.free.testOk", { text: test.text ?? "", input: test.inputTokens ?? 0, output: test.outputTokens ?? 0 })
              : t("ai.testFailed", { message: t(`assist.err.${assistError(new Error(test.error ?? ""))}`) })}
          </p>
          {!test.ok && test.message && <span className="model-error-detail">{test.message}</span>}
        </div>
      )}

      <h3 className="label">{t("ai.free.usage")}</h3>
      {!usage ? (
        <p className="hint">{t("loading")}</p>
      ) : usage.length === 0 ? (
        <p className="hint">{t("ai.noCalls")}</p>
      ) : (
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr><th>{t("ai.free.col.feature")}</th><th>{t("ai.col.calls")}</th><th>{t("ai.free.col.failed")}</th><th>{t("ai.free.col.tokens")}</th></tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.feature}>
                  <td>{t(`ai.free.feature.${u.feature}` as "ai.free.feature.translate")}</td>
                  <td className="num">{u.calls}</td>
                  <td className="num">{u.failed}</td>
                  <td className="num">{u.tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  );
}
