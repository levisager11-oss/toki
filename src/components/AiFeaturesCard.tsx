import { useEffect, useState } from "react";
import { useI18n, type Key } from "../lib/i18n";
import { CLAUDE_PRICES } from "../lib/claudeModels";
import {
  ApiError, connectError, findModels, getAiFeatures, saveAiFeature, testAi, usd, PLAYER_FEATURES, THINKING,
  type AiFeature, type AiFeatureModel, type ModelInfo, type TestResult,
} from "../lib/ai";

type Row = Omit<AiFeatureModel, "input_price" | "output_price"> & { input_price: string; output_price: string };

const toRow = (r: AiFeatureModel): Row => ({ ...r, input_price: r.input_price ? String(r.input_price) : "", output_price: r.output_price ? String(r.output_price) : "" });

/** Admins: which Claude model each AI feature uses (no model: the feature is off), its thinking and prices. */
export function AiFeaturesCard({ baseUrl, aiOn, onChanged }: { baseUrl: string; aiOn: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsMsg, setModelsMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<"" | "saved" | "error">("");
  const [tests, setTests] = useState<Partial<Record<AiFeature, TestResult | "running">>>({});

  useEffect(() => {
    getAiFeatures()
      .then((list) => {
        const r = list.map(toRow);
        setRows(r);
        setSaved(Object.fromEntries(r.map((x) => [x.feature, JSON.stringify(x)])));
      })
      .catch(() => setError(true));
  }, []);

  if (error) return <section className="ai-card"><p className="error" role="alert">{t("error")}</p></section>;
  if (!rows) return <section className="ai-card"><p className="hint" aria-busy="true">{t("loading")}</p></section>;

  // The models to choose from: Claude's known ones, those Anthropic listed, and any already chosen.
  const known = Object.keys(CLAUDE_PRICES);
  const ids = [...new Set([...known, ...models.map((m) => m.id), ...rows.map((r) => r.model).filter(Boolean)])].sort();
  const priceOf = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (m?.inputPrice !== undefined && m.outputPrice !== undefined) return { input: m.inputPrice, output: m.outputPrice };
    return CLAUDE_PRICES[id];
  };
  const dirty = (r: Row) => JSON.stringify(r) !== saved[r.feature];
  const anyDirty = rows.some(dirty);
  const set = (feature: AiFeature, change: Partial<Row>) => {
    setMsg("");
    setRows(rows.map((r) => (r.feature === feature ? { ...r, ...change } : r)));
  };
  const pick = (r: Row, model: string) => {
    const p = model ? priceOf(model) : undefined;
    set(r.feature, { model, ...(model ? (p ? { input_price: String(p.input), output_price: String(p.output) } : {}) : { input_price: "", output_price: "" }) });
  };

  const loadModels = async () => {
    setModelsMsg("");
    try {
      const list = await findModels(baseUrl);
      setModels(list);
      setModelsMsg(t("ai.features.modelsFound", { n: list.length }));
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "";
      setModelsMsg(t(code === "ai_not_configured" || code === "not_configured" ? "ai.models.needKey" : "ai.models.failed"));
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      const next = { ...saved };
      for (const r of rows.filter(dirty)) {
        await saveAiFeature({ ...r, input_price: Number(r.input_price) || 0, output_price: Number(r.output_price) || 0 });
        next[r.feature] = JSON.stringify(r);
      }
      setSaved(next);
      setMsg("saved");
      onChanged();
    } catch {
      setMsg("error");
    }
    setBusy(false);
  };

  const test = async (feature: AiFeature) => {
    setTests((x) => ({ ...x, [feature]: "running" }));
    let result: TestResult;
    try {
      result = await testAi(feature);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : "", message: e instanceof ApiError ? e.detail : "" };
    }
    setTests((x) => ({ ...x, [feature]: result }));
    onChanged();
  };

  // Every feature that has a model, one tiny call each (in turn, so the list fills as they finish).
  const [testingAll, setTestingAll] = useState(false);
  const testAll = async () => {
    setTestingAll(true);
    for (const r of rows.filter((x) => x.model && !dirty(x))) await test(r.feature);
    setTestingAll(false);
  };
  const tested = Object.values(tests).filter((x): x is TestResult => !!x && x !== "running");
  const failed = tested.filter((x) => !x.ok).length;

  return (
    <section className="form ai-card" aria-labelledby="ai-features-h">
      <h2 id="ai-features-h">{t("ai.features.title")}</h2>
      <p className="hint">{t("ai.features.lead")}</p>
      <div className="model-find">
        <button type="button" className="btn" onClick={loadModels}>{t("ai.models.find")}</button>
        <small aria-live="polite">{modelsMsg || t("ai.features.findHelp")}</small>
      </div>
      {aiOn && (
        <div className="model-find">
          <button type="button" className="btn" onClick={testAll} disabled={testingAll || anyDirty || !rows.some((r) => r.model)}>
            {testingAll ? t("ai.testing") : t("ai.testAll")}
          </button>
          <small aria-live="polite">
            {anyDirty ? t("ai.testSaveFirst") : !testingAll && tested.length ? (failed ? t("ai.testAllFailed", { n: failed }) : t("ai.testAllOk", { n: tested.length })) : t("ai.testAllHelp")}
          </small>
        </div>
      )}
      <ul className="ai-features">
        {rows.map((r) => {
          const id = `ai-f-${r.feature}`;
          const res = tests[r.feature];
          return (
            <li key={r.feature} className="ai-feature">
              <div className="ai-feature-head">
                <b id={`${id}-h`}>{t(`ai.feature.${r.feature}` as Key)}</b>
                <span className="sub">{t(PLAYER_FEATURES.includes(r.feature) ? "ai.features.forPlayers" : "ai.features.forDevs")}</span>
              </div>
              <small>{t(`ai.features.help.${r.feature}` as Key)}</small>
              <div className="pair">
                <div>
                  <label htmlFor={`${id}-model`}>{t("ai.model")}</label>
                  <select id={`${id}-model`} value={r.model} onChange={(e) => pick(r, e.target.value)}>
                    <option value="">{t("ai.features.off")}</option>
                    {ids.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`${id}-thinking`}>{t("ai.free.thinking")}</label>
                  <select id={`${id}-thinking`} value={r.thinking} disabled={!r.model} onChange={(e) => set(r.feature, { thinking: e.target.value as Row["thinking"] })}>
                    {THINKING.map((v) => <option key={v} value={v}>{t(`ai.free.thinking.${v}`)}</option>)}
                  </select>
                </div>
              </div>
              {r.model && (
                <div className="pair">
                  <div>
                    <label htmlFor={`${id}-in`}>{t("ai.inputPrice")}</label>
                    <input id={`${id}-in`} type="number" min="0" max="1000" step="0.0001" inputMode="decimal" value={r.input_price} onChange={(e) => set(r.feature, { input_price: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-out`}>{t("ai.outputPrice")}</label>
                    <input id={`${id}-out`} type="number" min="0" max="1000" step="0.0001" inputMode="decimal" value={r.output_price} onChange={(e) => set(r.feature, { output_price: e.target.value })} />
                  </div>
                </div>
              )}
              {r.model && aiOn && (
                <div className="setup-row">
                  <button type="button" className="linkish" onClick={() => test(r.feature)} disabled={res === "running" || dirty(r)}>
                    {res === "running" ? t("ai.testing") : t("ai.test")}
                  </button>
                  {dirty(r) && <small>{t("ai.testSaveFirst")}</small>}
                </div>
              )}
              {res && res !== "running" && (
                <div className={`check ${res.ok ? "good" : "warn"}`} role="status">
                  <p>
                    {res.ok
                      ? t("ai.testOk", { text: res.text ?? "", input: res.inputTokens ?? 0, output: res.outputTokens ?? 0, cost: usd(res.cost ?? 0) })
                      : t("ai.testFailed", { message: t(`connect.err.${connectError(res.error)}`) })}
                  </p>
                  {!res.ok && res.message && <span className="model-error-detail">{res.message}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <small>{t("ai.priceHelp")}</small>
      {msg === "saved" && <p className="check good" role="status">{t("ai.saved")}</p>}
      {msg === "error" && <p className="error" role="alert">{t("ai.features.saveError")}</p>}
      <div className="actions fb-form-actions">
        <button type="button" className="btn primary" onClick={save} disabled={busy || !anyDirty}>{t("ai.save")}</button>
      </div>
    </section>
  );
}
