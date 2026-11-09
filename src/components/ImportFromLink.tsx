import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { ApiError } from "../lib/ai";
import { importLink, type Imported } from "../lib/hosting";

const ERRORS = ["bad_url", "not_web", "not_found", "unreachable"] as const;
type ImportErr = (typeof ERRORS)[number] | "error";
const errCode = (e: unknown): ImportErr => {
  const c = e instanceof ApiError ? e.message : "";
  return (ERRORS as readonly string[]).includes(c) ? (c as ImportErr) : "error";
};

/** "Fill in from a link": an itch.io page, a GitHub repository or the page where the game runs. */
export function ImportFromLink({ onImport }: { onImport: (d: Imported) => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Imported["source"] | null>(null);

  const go = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setErr("");
    setDone(null);
    try {
      const d = await importLink(url.trim());
      onImport(d);
      setDone(d.source);
    } catch (e) {
      setErr(t(`import.err.${errCode(e)}`));
    }
    setBusy(false);
  };

  return (
    <details className="save-support import-box">
      <summary>
        <b>{t("import.title")}</b>
        <span>{t("import.lead")}</span>
      </summary>
      <div className="import-row">
        <input
          type="url"
          aria-label={t("import.title")}
          placeholder="https://you.itch.io/your-game"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
        />
        <button type="button" className="btn" onClick={go} disabled={busy || !url.trim()}>{busy ? t("import.busy") : t("import.go")}</button>
      </div>
      {done && <p className="check good" aria-live="polite">{t(`import.done.${done}`)}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </details>
  );
}
