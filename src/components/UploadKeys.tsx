import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { supabase } from "../lib/supabase";
import { agentPrompt, createUploadKey, githubWorkflow, hostError } from "../lib/hosting";

interface KeyRow {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * My games: personal upload keys, for publishing without the website (an AI agent, the upload
 * script or a GitHub Action), with the text to paste into the AI and the GitHub workflow.
 */
export function UploadKeys() {
  const { t, lang } = useI18n();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const origin = window.location.origin;

  const load = () =>
    supabase.from("upload_keys").select("id,name,hint,created_at,last_used_at").order("created_at").then(({ data }) => setKeys((data ?? []) as KeyRow[]));
  useEffect(() => {
    load().then(() => {
      // Linked from the game form ("Publish with an AI agent…"): show this part.
      if (window.location.hash === "#upload-keys") document.getElementById("upload-keys")?.scrollIntoView();
    });
  }, []);

  const make = async () => {
    setBusy(true);
    setErr("");
    try {
      const k = await createUploadKey(name.trim() || t("keys.defaultName"));
      setFresh(k.key);
      setName("");
      await load();
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
    }
    setBusy(false);
  };
  const remove = async (id: string) => {
    await supabase.from("upload_keys").delete().eq("id", id);
    if (fresh) setFresh(null);
    load();
  };
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard blocked: the text is shown too */
    }
  };
  const date = (s: string) => new Date(s).toLocaleDateString(lang === "de" ? "de-CH" : "en", { dateStyle: "medium" });
  const prompt = agentPrompt(fresh, origin);
  const workflow = githubWorkflow(origin);

  return (
    <section className="panel upload-keys" id="upload-keys" aria-labelledby="keys-h">
      <h2 className="h" id="keys-h">{t("keys.title")}</h2>
      <p className="lead">{t("keys.lead")}</p>

      {keys && keys.length > 0 && (
        <ul className="key-list">
          {keys.map((k) => (
            <li key={k.id}>
              <b>{k.name}</b>
              <span className="sub">
                toki_…{k.hint} · {t("keys.made", { date: date(k.created_at) })}
                {k.last_used_at ? ` · ${t("keys.used", { date: date(k.last_used_at) })}` : ""}
              </span>
              <button type="button" className="linkish danger-text" onClick={() => remove(k.id)}>{t("keys.delete")}</button>
            </li>
          ))}
        </ul>
      )}

      {fresh ? (
        <div className="key-fresh">
          <p className="check good">{t("keys.onlyOnce")}</p>
          <pre><code>{fresh}</code></pre>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => copy("prompt", prompt)} aria-live="polite">{copied === "prompt" ? t("saveSupport.copied") : t("keys.copyPrompt")}</button>
            <button type="button" className="btn" onClick={() => copy("key", fresh)} aria-live="polite">{copied === "key" ? t("saveSupport.copied") : t("keys.copyKey")}</button>
          </div>
        </div>
      ) : (
        <div className="import-row">
          <input aria-label={t("keys.name")} placeholder={t("keys.namePlaceholder")} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn primary" onClick={make} disabled={busy || (keys?.length ?? 0) >= 5}>{t("keys.create")}</button>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}

      <details className="save-support">
        <summary>
          <b>{t("keys.agentTitle")}</b>
          <span>{t("keys.agentLead")}</span>
        </summary>
        <ol className="steps">
          <li>{t("keys.agent1")}</li>
          <li>{t("keys.agent2")}</li>
          <li>{t("keys.agent3")}</li>
        </ol>
        <div className="actions">
          <button type="button" className="btn" onClick={() => copy("prompt2", prompt)} aria-live="polite">{copied === "prompt2" ? t("saveSupport.copied") : t("keys.copyPrompt")}</button>
          <a className="btn" href="/agents.md" target="_blank" rel="noreferrer">{t("keys.guide")}</a>
        </div>
        <pre><code>{prompt}</code></pre>
      </details>

      <details className="save-support">
        <summary>
          <b>{t("keys.githubTitle")}</b>
          <span>{t("keys.githubLead")}</span>
        </summary>
        <ol className="steps">
          <li>{t("keys.github1")}</li>
          <li>{t("keys.github2")}</li>
          <li>{t("keys.github3")}</li>
        </ol>
        <div className="actions">
          <button type="button" className="btn" onClick={() => copy("workflow", workflow)} aria-live="polite">{copied === "workflow" ? t("saveSupport.copied") : t("keys.copyWorkflow")}</button>
        </div>
        <pre><code>{workflow}</code></pre>
        <small>{t("keys.githubToki")}</small>
      </details>
    </section>
  );
}
