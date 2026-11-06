import { useState } from "react";
import { useI18n } from "../lib/i18n";
import snippet from "../../public/toki-save.js?raw";

const code = `<script>\n${snippet.trim()}\n</script>`;

// Instructions to paste into an AI coding agent working in the game's code.
const agentPrompt = `Add Toki save support to this web game.

Why: Toki (a game website) shows this game in an iframe. iPhones delete the storage of sites shown inside other sites when the app closes, so progress gets lost. The script below sends the game's localStorage to Toki, which keeps the save (on the device and in the player's account) and gives it back next time.

Do this:
1. In the game's main HTML file (the page Toki opens), add the script below as an inline <script> inside <head>, before the game's own scripts. Copy it exactly.
2. If the game saves with localStorage, nothing else is needed.
3. If the game saves another way (IndexedDB, Godot user:// files, cookies, a server), also keep a copy of the save in localStorage under one key: write it there every time the game saves, and when the game starts, load from that key if it exists. For Godot, use JavaScriptBridge to call localStorage.
4. Don't change anything else. Outside Toki the script does nothing.

Script:
${code}
`;

/** Tells creators how to make their game's progress survive on iPhones and sync to accounts. */
export function SaveSupport({ open }: { open?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"code" | "agent" | null>(null);

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
