import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import {
  aiStatus, clearAiKey, clearGithubApp, createGithubApp, githubAppStateMatches, githubFromManifest, setAiKey, type AiStatus, type Provider,
} from "../lib/ai";
import { githubManifest } from "../lib/githubManifest";

// Where this project's keys live, for the one step that has to happen outside Toki.
const SUPABASE_KEYS = "https://supabase.com/dashboard/project/oygszctxhkubofspywzr/settings/api-keys";
const VERCEL_ENV = "https://vercel.com/levisager11-oss-projects/toki/settings/environment-variables";
const VERCEL_DEPLOYS = "https://vercel.com/levisager11-oss-projects/toki/deployments";

/** Setting up the AI on Toki: the Supabase key (in Vercel), the key of the chosen provider and the GitHub App (here). */
export function AiSetup({ provider }: { provider: Provider }) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<AiStatus | "no_service_key" | null>(null);
  const [reload, setReload] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    aiStatus().then(setStatus).catch(() => setStatus("no_service_key"));
  }, [reload]);

  // Back from GitHub after creating the app: hand the one-time code to the server.
  useEffect(() => {
    const code = params.get("code");
    if (!code || handled.current) return;
    handled.current = true;
    const state = params.get("state");
    navigate("/admin/ai", { replace: true });
    if (!githubAppStateMatches(state)) return setMsg({ ok: false, text: t("setup.github.failed") });
    githubFromManifest(code)
      .then((r) => setMsg({ ok: true, text: t("setup.github.done", { name: r.slug }) }))
      .catch(() => setMsg({ ok: false, text: t("setup.github.failed") }))
      .finally(() => setReload((n) => n + 1));
  }, [params, navigate, t]);

  const ready = status !== null && status !== "no_service_key";
  const s = ready ? status : null;
  const anthropic = provider === "anthropic";
  const hasKey = anthropic ? !!s?.anthropicKey : !!s?.aiKey;
  const keySource = anthropic ? s?.anthropicKeySource : s?.aiKeySource;

  return (
    <section className="ai-card" aria-labelledby="ai-setup-h">
      <h2 id="ai-setup-h">{t("ai.setup")}</h2>
      {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}
      {status === null ? (
        <p className="hint">{t("loading")}</p>
      ) : (
        <ol className="setup-steps">
          <li className={ready ? "done" : "todo"}>
            <StepHead n={1} done={ready} title={t("setup.supabase.title")} />
            {ready ? (
              <p className="sub">{t("ai.status.set")}</p>
            ) : (
              <div className="setup-how">
                <p>{t("setup.supabase.why")}</p>
                <ol>
                  <li>{t("setup.supabase.step1")} <a href={SUPABASE_KEYS} target="_blank" rel="noopener noreferrer">{t("setup.supabase.openSupabase")} ↗</a></li>
                  <li>{t("setup.supabase.step2")} <a href={VERCEL_ENV} target="_blank" rel="noopener noreferrer">{t("setup.supabase.openVercel")} ↗</a></li>
                  <li>{t("setup.supabase.step3")} <CopyName text="SUPABASE_SECRET_KEY" /></li>
                  <li>{t("setup.supabase.step4")}</li>
                  <li>{t("setup.supabase.step5")} <a href={VERCEL_DEPLOYS} target="_blank" rel="noopener noreferrer">{t("setup.supabase.openDeploys")} ↗</a></li>
                </ol>
                <button type="button" className="btn" onClick={() => { setStatus(null); setReload((n) => n + 1); }}>{t("setup.checkAgain")}</button>
              </div>
            )}
          </li>

          <li className={hasKey ? "done" : "todo"}>
            <StepHead n={2} done={hasKey} title={t(anthropic ? "setup.anthropic.title" : "setup.ai.title")} />
            {!ready ? (
              <p className="sub">{t("setup.afterStep1")}</p>
            ) : hasKey ? (
              <div className="setup-row">
                <span className="sub">{t(keySource === "env" ? "setup.fromVercel" : "setup.ai.saved")}</span>
                {keySource === "toki" && (
                  <button type="button" className="linkish" onClick={() => clearAiKey(provider).then(() => setReload((n) => n + 1))}>{t("setup.remove")}</button>
                )}
              </div>
            ) : (
              <AiKeyForm key={provider} provider={provider} onSaved={() => setReload((n) => n + 1)} />
            )}
          </li>

          <li className={s?.github ? "done" : "todo"}>
            <StepHead n={3} done={!!s?.github} title={t("setup.github.title")} />
            {!ready ? (
              <p className="sub">{t("setup.afterStep1")}</p>
            ) : s?.github ? (
              <div className="setup-row">
                <span className="sub">
                  {s.githubSource === "env" ? t("setup.fromVercel") : t("setup.github.connected")}{" "}
                  {s.githubSlug && <a href={`https://github.com/apps/${s.githubSlug}`} target="_blank" rel="noopener noreferrer">github.com/apps/{s.githubSlug} ↗</a>}
                </span>
                {s.githubSource === "toki" && (
                  <button type="button" className="linkish" onClick={() => clearGithubApp().then(() => setReload((n) => n + 1))}>{t("setup.remove")}</button>
                )}
              </div>
            ) : (
              <div className="setup-how">
                <p>{t("setup.github.how")}</p>
                <button type="button" className="btn primary" onClick={() => createGithubApp(githubManifest(window.location.origin))}>{t("setup.github.create")}</button>
                <small>{t("setup.github.nameTaken")}</small>
              </div>
            )}
          </li>
        </ol>
      )}
    </section>
  );
}

function StepHead({ n, done, title }: { n: number; done: boolean; title: string }) {
  return (
    <span className="setup-head">
      <span className={`setup-num ${done ? "done" : ""}`} aria-hidden="true">{done ? "✓" : n}</span>
      <b>{title}</b>
    </span>
  );
}

function CopyName({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-name">
      <code>{text}</code>
      <button type="button" className="linkish" onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}>
        {copied ? t("saveSupport.copied") : t("setup.copy")}
      </button>
    </span>
  );
}

function AiKeyForm({ provider, onSaved }: { provider: Provider; onSaved: () => void }) {
  const { t } = useI18n();
  const anthropic = provider === "anthropic";
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(false);
    try {
      await setAiKey(key.trim(), provider);
      setKey("");
      onSaved();
    } catch {
      setErr(true);
    }
    setBusy(false);
  };
  return (
    <form className="setup-key" onSubmit={submit}>
      <label htmlFor="ai-key" className="sr-only">{t(anthropic ? "setup.anthropic.title" : "setup.ai.title")}</label>
      <input id="ai-key" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={500} value={key} onChange={(e) => setKey(e.target.value)} placeholder={t(anthropic ? "setup.anthropic.placeholder" : "setup.ai.placeholder")} />
      <button className="btn primary" disabled={busy || key.trim().length < 8}>{t("setup.ai.save")}</button>
      <small>{t(anthropic ? "setup.anthropic.help" : "setup.ai.help")}</small>
      {err && <p className="error" role="alert">{t("error")}</p>}
    </form>
  );
}
