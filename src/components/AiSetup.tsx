import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import {
  ApiError, aiStatus, checkAiKey, clearAiKey, clearGithubApp, connectError, createGithubApp, githubAppStateMatches, githubFromManifest, setAiKey, testAi, usd,
  STARTER_CAP, STARTER_QUOTA, type AiFeature, type AiStatus,
} from "../lib/ai";
import { githubManifest } from "../lib/githubManifest";

// Where this project's keys live, for the one step that has to happen outside Toki.
const SUPABASE_KEYS = "https://supabase.com/dashboard/project/oygszctxhkubofspywzr/settings/api-keys";
const VERCEL_ENV = "https://vercel.com/levisager11-oss-projects/toki/settings/environment-variables";
const VERCEL_DEPLOYS = "https://vercel.com/levisager11-oss-projects/toki/deployments";

/** The AI's main settings, as far as setting up needs them (from the settings form on the page). */
export interface AiSwitch {
  enabled: boolean;
  cap: number;
  quota: number;
  /** a feature with a model, to try after turning on */
  firstFeature: AiFeature | null;
}

/**
 * Setting up the AI on Toki: the Supabase key (in Vercel), the Anthropic API key (checked with
 * Anthropic before it's saved), turning the AI on with starter limits, and the GitHub App.
 */
export function AiSetup({ ai, onTurnOn }: { ai: AiSwitch | null; onTurnOn: () => Promise<void> }) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<AiStatus | "no_service_key" | "error" | null>(null);
  const [reload, setReload] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    // Only "not_configured" means the key is missing; anything else (offline, a server hiccup) is just an error.
    aiStatus()
      .then(setStatus)
      .catch((e) => setStatus(e instanceof ApiError && e.message === "not_configured" ? "no_service_key" : "error"));
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

  const ready = status !== null && status !== "no_service_key" && status !== "error";
  const again = () => { setStatus(null); setReload((n) => n + 1); };
  // Removing a key or the app: asked once more, then done with a busy state.
  const [confirm, setConfirm] = useState<"" | "key" | "github">("");
  const [removing, setRemoving] = useState(false);
  const remove = (what: "key" | "github") => {
    if (confirm !== what) return setConfirm(what);
    setRemoving(true);
    setMsg(null);
    (what === "key" ? clearAiKey() : clearGithubApp())
      .then(() => setReload((n) => n + 1))
      .catch(() => setMsg({ ok: false, text: t("error") }))
      .finally(() => { setRemoving(false); setConfirm(""); });
  };
  const s = ready ? status : null;
  const hasKey = !!s?.anthropicKey;
  const keySource = s?.anthropicKeySource;

  // Does Anthropic accept the key in use? Asked once the key is there (free).
  const [keyCheck, setKeyCheck] = useState<{ ok: boolean; error?: string; message?: string } | "checking" | null>(null);
  useEffect(() => {
    if (!hasKey) return setKeyCheck(null);
    setKeyCheck("checking");
    checkAiKey().then(setKeyCheck, () => setKeyCheck({ ok: false, error: "error" }));
  }, [hasKey, reload]);

  // Turning the AI on, then one tiny test call, so a missing credit shows up right away.
  const [turning, setTurning] = useState<"" | "busy" | "done">("");
  const [turnResult, setTurnResult] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
  const turnOn = async () => {
    setTurning("busy");
    setTurnResult(null);
    try {
      await onTurnOn();
      if (ai?.firstFeature) {
        const r = await testAi(ai.firstFeature).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : "", message: e instanceof ApiError ? e.detail : "", cost: 0 }));
        setTurnResult(r.ok
          ? { ok: true, text: t("setup.on.works", { cost: usd(r.cost ?? 0) }) }
          : { ok: false, text: t(r.error === "ai_no_credit" ? "setup.on.noCredit" : "setup.on.testFailed", { message: t(`connect.err.${connectError(r.error)}`) }), detail: r.message });
      }
      setTurning("done");
    } catch {
      setTurnResult({ ok: false, text: t("ai.saveError") });
      setTurning("");
    }
  };
  const isOn = !!ai && ai.enabled && ai.cap > 0;

  return (
    <section className="ai-card" aria-labelledby="ai-setup-h">
      <h2 id="ai-setup-h">{t("ai.setup")}</h2>
      {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}
      {status === null ? (
        <p className="hint">{t("loading")}</p>
      ) : status === "error" ? (
        <div className="msg">
          <p className="error" role="alert">{t("error")}</p>
          <button type="button" className="btn" onClick={again}>{t("setup.checkAgain")}</button>
        </div>
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
                <button type="button" className="btn" onClick={again}>{t("setup.checkAgain")}</button>
              </div>
            )}
          </li>

          <li className={hasKey ? "done" : "todo"}>
            <StepHead n={2} done={hasKey} title={t("setup.anthropic.title")} />
            {!ready ? (
              <p className="sub">{t("setup.afterStep1")}</p>
            ) : hasKey ? (
              <>
                <div className="setup-row">
                  <span className="sub">{t(keySource === "env" ? "setup.fromVercel" : "setup.ai.saved")}</span>
                  {keySource === "toki" && (
                    <button type="button" className="linkish" disabled={removing} onClick={() => remove("key")}>{confirm === "key" ? t("setup.removeSure") : t("setup.remove")}</button>
                  )}
                </div>
                {keyCheck === "checking" && <p className="sub" aria-busy="true">{t("setup.key.checking")}</p>}
                {keyCheck && keyCheck !== "checking" && (
                  keyCheck.ok ? (
                    <p className="check good" role="status">{t("setup.key.works")}</p>
                  ) : (
                    <div className="check warn" role="status">
                      <p>{t(keyCheck.error === "ai_bad_key" ? "setup.key.refused" : "setup.key.unchecked")}</p>
                      {keyCheck.message && <span className="model-error-detail">{keyCheck.message}</span>}
                    </div>
                  )
                )}
              </>
            ) : (
              <AiKeyForm onSaved={() => setReload((n) => n + 1)} />
            )}
          </li>

          <li className={isOn ? "done" : "todo"}>
            <StepHead n={3} done={isOn} title={t("setup.on.title")} />
            {!hasKey || !ai ? (
              <p className="sub">{t("setup.on.afterKey")}</p>
            ) : isOn && !turning ? (
              <p className="sub">{t("setup.on.isOn", { cap: usd(ai.cap), quota: usd(ai.quota) })}</p>
            ) : (
              <div className="setup-how">
                {!isOn && (
                  <>
                    <p>{t("setup.on.how", { cap: usd(ai.cap > 0 ? ai.cap : STARTER_CAP), quota: usd(ai.quota > 0 ? ai.quota : STARTER_QUOTA) })}</p>
                    <button type="button" className="btn primary" disabled={turning === "busy" || keyCheck === "checking" || (typeof keyCheck === "object" && keyCheck?.error === "ai_bad_key")} onClick={turnOn}>
                      {turning === "busy" ? t("setup.on.busy") : t("setup.on.button")}
                    </button>
                  </>
                )}
                {turning === "busy" && isOn && <p className="sub" aria-busy="true">{t("setup.on.testing")}</p>}
                {turnResult && (
                  <div className={`check ${turnResult.ok ? "good" : "warn"}`} role="status">
                    <p>{turnResult.text}</p>
                    {turnResult.detail && <span className="model-error-detail">{turnResult.detail}</span>}
                  </div>
                )}
              </div>
            )}
          </li>

          <li className={s?.github ? "done" : "todo"}>
            <StepHead n={4} done={!!s?.github} title={t("setup.github.title")} />
            {!ready ? (
              <p className="sub">{t("setup.afterStep1")}</p>
            ) : s?.github ? (
              <div className="setup-row">
                <span className="sub">
                  {s.githubSource === "env" ? t("setup.fromVercel") : t("setup.github.connected")}{" "}
                  {s.githubSlug && <a href={`https://github.com/apps/${s.githubSlug}`} target="_blank" rel="noopener noreferrer">github.com/apps/{s.githubSlug} ↗</a>}
                </span>
                {s.githubSource === "toki" && (
                  <button type="button" className="linkish" disabled={removing} onClick={() => remove("github")}>{confirm === "github" ? t("setup.removeSure") : t("setup.remove")}</button>
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

function AiKeyForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  // Why the key wasn't saved: Anthropic refused it, or couldn't be asked (then it may be saved anyway).
  const [err, setErr] = useState<{ code: string; detail: string } | null>(null);
  const submit = async (e: FormEvent | null, force = false) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await setAiKey(key.trim(), force);
      setKey("");
      onSaved();
    } catch (x) {
      setErr({ code: x instanceof ApiError ? x.message : "error", detail: x instanceof ApiError ? x.detail : "" });
    }
    setBusy(false);
  };
  const unreachable = !!err && err.code !== "ai_bad_key" && err.code !== "bad_request" && err.code !== "error";
  return (
    <form className="setup-key" onSubmit={submit}>
      <label htmlFor="ai-key" className="sr-only">{t("setup.anthropic.title")}</label>
      <input id="ai-key" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={500} value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("setup.anthropic.placeholder")} />
      <button className="btn primary" disabled={busy || key.trim().length < 8}>{busy ? t("setup.key.checking") : t("setup.ai.save")}</button>
      <small>{t("setup.anthropic.help")}</small>
      {err && (
        <div className="error" role="alert">
          <p>{t(err.code === "ai_bad_key" ? "setup.key.refused" : unreachable ? "setup.key.unreachable" : "error")}</p>
          {err.detail && <span className="model-error-detail">{err.detail}</span>}
          {unreachable && <button type="button" className="linkish" disabled={busy} onClick={() => submit(null, true)}>{t("setup.key.saveAnyway")}</button>}
        </div>
      )}
    </form>
  );
}
