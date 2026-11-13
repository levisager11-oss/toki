import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { assistError, improvePrompt, useAiFeature, type ImprovePrompt } from "../lib/assist";
import { AiBox } from "./AiBits";

/**
 * "Make a prompt for an AI": the AI reads a game's open feedback, leaves out what doesn't help,
 * and Toki shows a prompt to copy into any AI that works on the game's code.
 * gameId: a game, "toki", or "" while no single game is chosen. Nothing when summaries are off.
 */
export function PromptButton({ gameId }: { gameId: string }) {
  const { t, lang } = useI18n();
  const on = useAiFeature("summary");
  const [result, setResult] = useState<ImprovePrompt | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!on) return null;

  const run = async () => {
    if (!gameId) return setPick(true);
    setBusy(true);
    setErr("");
    try {
      const r = await improvePrompt(gameId, lang);
      setResult(r);
      setText(r.prompt);
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is there to copy by hand */
    }
  };

  const label = t("fb.inbox.aiPrompt");
  return (
    <div className="ai-inline">
      <button type="button" className="linkish ai-link" onClick={run} disabled={busy}>
        {busy ? t("fb.prompt.busy") : label}
      </button>
      {pick && !gameId && <p className="hint" role="status">{t("fb.prompt.pickGame")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {result && (
        <AiBox title={label} onClose={() => setResult(null)}>
          {result.prompt ? (
            <>
              <p>{t("fb.prompt.how")}</p>
              <textarea className="prompt-text" rows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("fb.prompt.label")} spellCheck={false} />
              <div className="actions">
                <button type="button" className="btn primary" onClick={copy} disabled={!text.trim()} aria-live="polite">
                  {copied ? t("fb.prompt.copied") : t("fb.prompt.copy")}
                </button>
                <span className="sub">{t("fb.prompt.count", { used: result.used, total: result.total })}</span>
              </div>
            </>
          ) : (
            <p className="hint">{t(result.total ? "fb.prompt.nothingUseful" : "fb.prompt.none")}</p>
          )}
          {result.skipped.length > 0 && (
            <details className="prompt-skipped">
              <summary>{t("fb.prompt.skipped", { n: result.skipped.length })}</summary>
              <ul>
                {result.skipped.map((p) => (
                  <li key={p.id}>
                    <Link to={`/feedback/${p.id}`}>{p.title}</Link> <span className="sub">· {t(`fb.prompt.why.${p.why}`)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </AiBox>
      )}
    </div>
  );
}
