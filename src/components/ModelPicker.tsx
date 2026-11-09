import { useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import { ApiError, findModels, searchModels, tokensShort, type ModelInfo, type Provider } from "../lib/ai";

const SHOWN = 60;

/** Finds the models the AI endpoint offers, to search and pick one instead of typing its name. */
export function ModelPicker({ provider, baseUrl, selected, onPick }: { provider: Provider; baseUrl: string; selected: string; onPick: (m: ModelInfo) => void }) {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState("");
  const found = useMemo(() => (models ? searchModels(models, query) : []), [models, query]);

  const load = async () => {
    setBusy(true);
    setErr("");
    setDetail("");
    try {
      const list = await findModels(provider, baseUrl);
      setModels(list);
      if (!list.length) setErr(t("ai.models.none"));
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "";
      setDetail(e instanceof ApiError ? e.detail : "");
      setErr(t(code === "bad_url" ? "ai.models.needUrl" : code === "ai_not_configured" ? "ai.models.needKey" : "ai.models.failed"));
    }
    setBusy(false);
  };

  const price = (m: ModelInfo) =>
    m.inputPrice !== undefined && m.outputPrice !== undefined ? t("ai.models.price", { input: m.inputPrice, output: m.outputPrice }) : "";

  return (
    <div className="model-picker">
      {!models?.length ? (
        <div className="model-find">
          <button type="button" className="btn" onClick={load} disabled={busy}>{busy ? t("loading") : t("ai.models.find")}</button>
          <small>{t("ai.models.help")}</small>
        </div>
      ) : (
        <>
          <label htmlFor="model-search" className="sr-only">{t("ai.models.search")}</label>
          <input id="model-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("ai.models.search")} autoComplete="off" spellCheck={false} autoFocus />
          <p className="sub" aria-live="polite">{t("ai.models.count", { n: found.length })}</p>
          <ul className="model-list">
            {found.slice(0, SHOWN).map((m) => (
              <li key={m.id}>
                <button type="button" aria-pressed={m.id === selected} onClick={() => onPick(m)}>
                  <b>{m.id}</b>
                  {(m.name || m.context || price(m)) && (
                    <span className="sub">{[m.name, m.context ? t("ai.models.context", { n: tokensShort(m.context) }) : "", price(m)].filter(Boolean).join(" · ")}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {found.length > SHOWN && <p className="sub">{t("ai.models.more", { n: found.length - SHOWN })}</p>}
        </>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
          {detail && <small className="model-error-detail">{detail}</small>}
        </p>
      )}
    </div>
  );
}
