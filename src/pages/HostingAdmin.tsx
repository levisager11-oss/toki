import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { clearHostingConfig, hostError, hostingStatus, saveHostingConfig, saveWebhookSecret, testHostingConfig, type HostingStatus } from "../lib/hosting";

/** Admins: the Cloudflare R2 settings for games hosted on Toki (/admin/hosting). */
export function HostingAdmin() {
  const { t } = useI18n();
  useTitle(t("nav.hosting"));
  const [s, setS] = useState<HostingStatus | null>(null);
  const [form, setForm] = useState({ accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "toki-games", domain: "playtoki.app" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => hostingStatus(true).then(setS);
  useEffect(() => {
    load();
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveHostingConfig(form);
      const test = await testHostingConfig();
      setMsg(test.ok ? { ok: true, text: t("hostAdmin.works") } : { ok: false, text: `${t("hostAdmin.failed")} ${test.message ?? ""}` });
      setForm((f) => ({ ...f, secretAccessKey: "" }));
      await load();
    } catch (err) {
      setMsg({ ok: false, text: t(`host.err.${hostError(err)}`, { mb: "100 MB" }) });
    }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    const r = await testHostingConfig().catch(() => ({ ok: false, message: "" }));
    setMsg(r.ok ? { ok: true, text: t("hostAdmin.works") } : { ok: false, text: `${t("hostAdmin.failed")} ${r.message ?? ""}` });
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    await clearHostingConfig().catch(() => {});
    await load();
    setBusy(false);
  };

  return (
    <section className="panel narrow">
      <h1 className="h">{t("nav.hosting")}</h1>
      <p className="lead">{t("hostAdmin.lead")}</p>
      {s && (
        <p className={`check ${s.enabled ? "good" : ""}`}>
          {s.enabled ? t("hostAdmin.on", { domain: s.domain ?? "", bucket: s.bucket ?? "" }) : t("hostAdmin.off")}
          {s.source === "env" ? ` ${t("hostAdmin.fromEnv")}` : ""}
        </p>
      )}
      {s?.enabled && (
        <div className="actions">
          <button type="button" className="btn" onClick={test} disabled={busy}>{t("hostAdmin.test")}</button>
          {s.source === "toki" && <button type="button" className="btn ghost-danger" onClick={clear} disabled={busy}>{t("hostAdmin.clear")}</button>}
        </div>
      )}
      {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}

      <form className="form" onSubmit={save}>
        <p>{t("hostAdmin.how")} <a href="https://github.com/levisager11-oss/toki/blob/main/docs/hosting-setup.md" target="_blank" rel="noreferrer">docs/hosting-setup.md</a></p>
        <label htmlFor="r2-account">{t("hostAdmin.account")}</label>
        <input id="r2-account" required pattern="[0-9a-fA-F]{32}" value={form.accountId} onChange={set("accountId")} autoComplete="off" />
        <label htmlFor="r2-key">{t("hostAdmin.keyId")}</label>
        <input id="r2-key" required value={form.accessKeyId} onChange={set("accessKeyId")} autoComplete="off" />
        <label htmlFor="r2-secret">{t("hostAdmin.secret")}</label>
        <input id="r2-secret" required type="password" value={form.secretAccessKey} onChange={set("secretAccessKey")} autoComplete="off" />
        <label htmlFor="r2-bucket">{t("hostAdmin.bucket")}</label>
        <input id="r2-bucket" required value={form.bucket} onChange={set("bucket")} />
        <label htmlFor="r2-domain">{t("hostAdmin.domain")}</label>
        <input id="r2-domain" required value={form.domain} onChange={set("domain")} aria-describedby="r2-domain-help" />
        <small id="r2-domain-help">{t("hostAdmin.domainHelp")}</small>
        <div className="actions">
          <button className="btn primary" disabled={busy}>{busy ? t("form.saving") : t("hostAdmin.save")}</button>
        </div>
      </form>
      <WebhookSecret />
    </section>
  );
}

/** For a GitHub App made before Toki listened to pushes: its webhook's secret. */
function WebhookSecret() {
  const { t } = useI18n();
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await saveWebhookSecret(secret.trim());
      setSecret("");
      setMsg({ ok: true, text: t("hostAdmin.webhookSaved") });
    } catch (err) {
      const code = hostError(err);
      setMsg({ ok: false, text: code === "error" && err instanceof Error && err.message === "github_env" ? t("hostAdmin.webhookEnv") : t(`host.err.${code}`, { mb: "100 MB" }) });
    }
  };
  return (
    <form className="form" onSubmit={save}>
      <h2 className="h">{t("hostAdmin.webhookTitle")}</h2>
      <p>{t("hostAdmin.webhookHow")}</p>
      <label htmlFor="gh-webhook">{t("hostAdmin.webhookSecret")}</label>
      <input id="gh-webhook" type="password" required minLength={8} maxLength={200} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      <div className="actions">
        <button className="btn">{t("hostAdmin.webhookSave")}</button>
      </div>
      {msg && <p className={`check ${msg.ok ? "good" : "warn"}`} role="status">{msg.text}</p>}
    </form>
  );
}
