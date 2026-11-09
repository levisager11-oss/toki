import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { clearHostingConfig, hostError, hostingStatus, saveHostingConfig, saveWebhookSecret, testHostingConfig, type HostingStatus } from "../lib/hosting";

const GUIDE = "https://github.com/levisager11-oss/toki/blob/main/docs/hosting-setup.md";

/** "1.2 MB", "340 KB", "2.1 GB" */
function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type Msg = { ok: boolean; text: string } | null;

/** Admins: where uploaded games live (Cloudflare R2) and GitHub auto-updates (/admin/hosting). */
export function HostingAdmin() {
  const { t } = useI18n();
  useTitle(t("nav.hosting"));
  const [s, setS] = useState<HostingStatus | null>(null);
  const load = () => hostingStatus(true).then(setS);
  useEffect(() => {
    load();
  }, []);

  return (
    <section className="fb-board ai-admin host-admin">
      <h1 className="h">{t("nav.hosting")}</h1>
      <p className="lead">{t("hostAdmin.lead")}</p>
      {!s ? <p className="msg" aria-busy="true">{t("loading")}</p> : (
        <>
          <StorageCard s={s} reload={load} />
          <GitHubCard s={s} reload={load} />
        </>
      )}
    </section>
  );
}

function StorageCard({ s, reload }: { s: HostingStatus; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const used = s.usedBytes ?? 0;
  const limit = s.limitBytes ?? 1;
  const pct = Math.min(100, (used / limit) * 100);

  const runTest = async () => {
    setBusy(true);
    setMsg(null);
    const r = await testHostingConfig().catch(() => ({ ok: false, message: "" }));
    setMsg(r.ok ? { ok: true, text: t("hostAdmin.works") } : { ok: false, text: `${t("hostAdmin.failed")} ${r.message ?? ""}` });
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    await clearHostingConfig().catch(() => {});
    setConfirmClear(false);
    setMsg(null);
    await reload();
    setBusy(false);
  };

  return (
    <section className="ai-card" aria-labelledby="host-storage-h">
      <div className="host-card-head">
        <h2 id="host-storage-h">{t("hostAdmin.storage")}</h2>
        <span className={`host-pill ${s.enabled ? "on" : ""}`}>{s.enabled ? t("hostAdmin.statusOn") : t("hostAdmin.statusOff")}</span>
      </div>

      {s.enabled ? (
        <>
          <p className="ai-big">{t("hostAdmin.used", { used: size(used), limit: size(limit) })}</p>
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("hostAdmin.storage")}>
            <i className={pct >= 80 ? "warn" : ""} style={{ width: `${Math.max(pct, used > 0 ? 1 : 0)}%` }} />
          </div>
          <p className="sub">
            {t("hostAdmin.games", { n: s.hostedGames ?? 0 })}
            {(s.followingGames ?? 0) > 0 && ` · ${t("hostAdmin.following", { n: s.followingGames ?? 0 })}`}
          </p>
          <dl className="host-facts">
            <dt>{t("hostAdmin.address")}</dt>
            <dd><code>{`<game>.${s.domain}`}</code></dd>
            <dt>{t("hostAdmin.bucket")}</dt>
            <dd><code>{s.bucket}</code></dd>
            <dt>{t("hostAdmin.keys")}</dt>
            <dd>{s.source === "env" ? t("hostAdmin.keysEnv") : t("hostAdmin.keysToki")}</dd>
          </dl>
          {!editing && (
            <div className="actions">
              <button type="button" className="btn" onClick={runTest} disabled={busy}>{busy && !confirmClear ? t("ai.testing") : t("hostAdmin.test")}</button>
              {s.source === "toki" && <button type="button" className="btn" onClick={() => { setEditing(true); setMsg(null); }}>{t("hostAdmin.change")}</button>}
              {s.source === "toki" && (
                confirmClear
                  ? <button type="button" className="btn danger" onClick={clear} disabled={busy}>{t("hostAdmin.confirmClear")}</button>
                  : <button type="button" className="btn ghost-danger" onClick={() => setConfirmClear(true)}>{t("hostAdmin.clear")}</button>
              )}
            </div>
          )}
          {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}
        </>
      ) : (
        <p>{t("hostAdmin.off")}</p>
      )}

      {(!s.enabled || editing) && (
        <SetupForm
          s={s}
          onDone={async (m) => {
            setMsg(m);
            if (m?.ok) setEditing(false);
            await reload();
          }}
          onCancel={s.enabled ? () => setEditing(false) : undefined}
        />
      )}
    </section>
  );
}

function SetupForm({ s, onDone, onCancel }: { s: HostingStatus; onDone: (m: Msg) => Promise<void>; onCancel?: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    accountId: s.accountId ?? "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: s.bucket ?? "toki-games",
    domain: s.domain ?? "playtoki.app",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await saveHostingConfig(form);
      const test = await testHostingConfig();
      await onDone(test.ok ? { ok: true, text: t("hostAdmin.works") } : { ok: false, text: `${t("hostAdmin.failed")} ${test.message ?? ""}` });
    } catch (x) {
      setErr(t(`host.err.${hostError(x)}`, { mb: "100 MB" }));
    }
    setBusy(false);
  };

  return (
    <form className="form host-setup" onSubmit={save}>
      <p className="sub">{t("hostAdmin.how")} <a href={GUIDE} target="_blank" rel="noreferrer">{t("hostAdmin.guide")}</a></p>
      <label htmlFor="r2-account">{t("hostAdmin.account")}</label>
      <input id="r2-account" required pattern="[0-9a-fA-F]{32}" value={form.accountId} onChange={set("accountId")} autoComplete="off" spellCheck={false} />
      <label htmlFor="r2-key">{t("hostAdmin.keyId")}</label>
      <input id="r2-key" required value={form.accessKeyId} onChange={set("accessKeyId")} autoComplete="off" spellCheck={false} />
      <label htmlFor="r2-secret">{t("hostAdmin.secret")}</label>
      <input id="r2-secret" required type="password" value={form.secretAccessKey} onChange={set("secretAccessKey")} autoComplete="off" />
      <div className="pair">
        <div>
          <label htmlFor="r2-bucket">{t("hostAdmin.bucket")}</label>
          <input id="r2-bucket" required value={form.bucket} onChange={set("bucket")} spellCheck={false} />
        </div>
        <div>
          <label htmlFor="r2-domain">{t("hostAdmin.domain")}</label>
          <input id="r2-domain" required value={form.domain} onChange={set("domain")} aria-describedby="r2-domain-help" spellCheck={false} />
        </div>
      </div>
      <small id="r2-domain-help">{t("hostAdmin.domainHelp")}</small>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        <button className="btn primary" disabled={busy}>{busy ? t("ai.testing") : t("hostAdmin.save")}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>{t("form.cancel")}</button>}
      </div>
    </form>
  );
}

function GitHubCard({ s, reload }: { s: HostingStatus; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const on = !!s.webhook;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await saveWebhookSecret(secret.trim());
      setSecret("");
      setEditing(false);
      setMsg({ ok: true, text: t("hostAdmin.webhookSaved") });
      await reload();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setMsg({ ok: false, text: code === "github_env" ? t("hostAdmin.webhookEnv") : t(`host.err.${hostError(err)}`, { mb: "100 MB" }) });
    }
  };

  return (
    <section className="ai-card" aria-labelledby="host-github-h">
      <div className="host-card-head">
        <h2 id="host-github-h">{t("hostAdmin.webhookTitle")}</h2>
        <span className={`host-pill ${on ? "on" : ""}`}>{on ? t("hostAdmin.statusOn") : t("hostAdmin.statusOff")}</span>
      </div>
      <p>{t("hostAdmin.webhookLead")}</p>

      {!s.github ? (
        <p className="check">{t("hostAdmin.githubFirst")} <Link to="/admin/ai">{t("nav.ai")}</Link></p>
      ) : on && !editing ? (
        <div className="actions">
          <button type="button" className="btn" onClick={() => setEditing(true)}>{t("hostAdmin.webhookChange")}</button>
        </div>
      ) : (
        <form className="form host-setup" onSubmit={save}>
          {!on && (
            <ol className="steps">
              <li>{t("hostAdmin.webhookStep1")}</li>
              <li>{t("hostAdmin.webhookStep2")} <code>https://www.playtoki.app/api/github</code></li>
              <li>{t("hostAdmin.webhookStep3")}</li>
              <li>{t("hostAdmin.webhookStep4")}</li>
            </ol>
          )}
          <label htmlFor="gh-webhook">{t("hostAdmin.webhookSecret")}</label>
          <input id="gh-webhook" type="password" required minLength={8} maxLength={200} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
          <div className="actions">
            <button className="btn primary">{t("hostAdmin.webhookSave")}</button>
            {on && <button type="button" className="btn" onClick={() => setEditing(false)}>{t("form.cancel")}</button>}
          </div>
        </form>
      )}
      {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}
    </section>
  );
}
