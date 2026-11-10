import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useAiStatus } from "../lib/assist";
import snippet from "../../public/toki-save.js?raw";
import { integrationGuide, scriptTag } from "../lib/integration";

const code = scriptTag(snippet);
// Instructions to paste into an AI coding agent working in the game's code.
const agentPrompt = integrationGuide(snippet);

/** Tells creators how to make their game's progress survive on iPhones and sync to accounts. */
export function SaveSupport({ open, gameId }: { open?: boolean; gameId?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"code" | "agent" | null>(null);
  // Toki Connect is offered only while the strong AI is on.
  const connect = useAiStatus().strong;

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
      <ul className="save-points">
        <li>{t("saveSupport.saves")}</li>
        <li>{t("saveSupport.scores")}</li>
        <li>{t("saveSupport.multiplayer")}</li>
      </ul>
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

/**
 * For developers: how friends get invited into their game's multiplayer rooms, and the two ways
 * to add it (Toki Connect, or instructions for an AI agent working in the game's code).
 */
export function MultiplayerSetup({ open, gameId, id }: { open?: boolean; gameId?: string; id?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const connect = useAiStatus().strong;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${agentPrompt}\nThis time, add only step 5 (play together). The script from step 1 must be in the page as well: add it if it's missing, and replace an older copy that has no toki.onHost.\n`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <details className="save-support" id={id} open={open}>
      <summary>
        <b>{t("mp.setup.title")}</b>
        <span>{t("mp.setup.lead")}</span>
      </summary>
      <p>{t("mp.setup.how")}</p>
      <ol className="save-points">
        <li>{t("mp.setup.step1")}</li>
        <li>{t("mp.setup.step2")}</li>
        <li>{t("mp.setup.step3")}</li>
      </ol>
      {connect && (
        <div className="save-connect">
          <p>{t("mp.setup.connect")}</p>
          <Link to={`/connect?add=multiplayer${gameId ? `&game=${gameId}` : ""}`} className="btn primary">{t("mp.setup.connectGo")}</Link>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={copy} aria-live="polite">
          {copied ? t("saveSupport.copied") : t("saveSupport.copyAgent")}
        </button>
      </div>
      <small>{t("mp.setup.script")}</small>
    </details>
  );
}
