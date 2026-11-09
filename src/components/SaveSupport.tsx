import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { myBudget } from "../lib/ai";
import snippet from "../../public/toki-save.js?raw";
import { integrationGuide, scriptTag } from "../lib/integration";

const code = scriptTag(snippet);
// Instructions to paste into an AI coding agent working in the game's code.
const agentPrompt = integrationGuide(snippet);

/** Tells creators how to make their game's progress survive on iPhones and sync to accounts. */
export function SaveSupport({ open, gameId }: { open?: boolean; gameId?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"code" | "agent" | null>(null);
  // Toki Connect is offered only while admins have the AI turned on.
  const [connect, setConnect] = useState(false);
  useEffect(() => {
    let alive = true;
    myBudget()
      .then((b) => alive && setConnect(b.enabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const copy = async (what: "code" | "agent") => {
    try {
      await navigator.clipboard.writeText(what === "code" ? code : agentPrompt);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard blocked: the code is also shown below */
    }
  };

  return (
    <details className="save-support" open={open}>
      <summary>
        <b>{t("saveSupport.title")}</b>
        <span>{t("saveSupport.lead")}</span>
      </summary>
      <p>{t("saveSupport.how")}</p>
      {connect && (
        <div className="save-connect">
          <p>
            <b>{t("saveSupport.connectTitle")}</b> {t("saveSupport.connectHow")}
          </p>
          <Link to={gameId ? `/connect?game=${gameId}` : "/connect"} className="btn primary">{t("saveSupport.connectGo")}</Link>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => copy("code")} aria-live="polite">
          {copied === "code" ? t("saveSupport.copied") : t("saveSupport.copyCode")}
        </button>
        <button type="button" className="btn" onClick={() => copy("agent")} aria-live="polite">
          {copied === "agent" ? t("saveSupport.copied") : t("saveSupport.copyAgent")}
        </button>
      </div>
      <small>{t("saveSupport.other")}</small>
      <pre><code>{code}</code></pre>
    </details>
  );
}
