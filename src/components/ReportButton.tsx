import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { REPORT_CATEGORIES, REPORT_REASON_MAX, reportContent, type ReportCategory, type ReportKind } from "../lib/account";
import { SocialError } from "../lib/social";

/** "Report": tells Toki's admins about a game, a profile, a feedback post or an idea that breaks the rules or the law. */
export function ReportButton({ kind, target, className = "linkish" }: { kind: ReportKind; target: string; className?: string }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  if (done) return <span className="sub" role="status">{t("report.sent")}</span>;
  if (!open) return <button type="button" className={className} onClick={() => setOpen(true)}>{t("chat.report")}</button>;
  // Without an account: by email, so anyone can report.
  if (!session)
    return (
      <p className="hint report-box">
        {t("report.guest")} <Link to="/imprint">{t("nav.imprint")}</Link> · <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>{t("nav.login")}</Link>
      </p>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!category) return;
    setBusy(true);
    setErr("");
    try {
      await reportContent(kind, target, category, reason.trim());
      setDone(true);
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    }
    setBusy(false);
  };

  return (
    <form className="form report-box" onSubmit={submit}>
      <label htmlFor={`report-${target}`}>{t("report.what")}</label>
      <select id={`report-${target}`} required autoFocus value={category} onChange={(e) => setCategory(e.target.value as ReportCategory)}>
        <option value="">{t("report.choose")}</option>
        {REPORT_CATEGORIES.map((c) => <option key={c} value={c}>{t(`report.cat.${c}`)}</option>)}
      </select>
      <label htmlFor={`report-why-${target}`}>{t("report.why")}</label>
      <textarea id={`report-why-${target}`} rows={3} maxLength={REPORT_REASON_MAX} required={category === "illegal" || category === "copyright"} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`report-help-${target}`} />
      <small id={`report-help-${target}`}>{t(category === "copyright" ? "report.copyrightHelp" : "report.help")}</small>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions">
        <button className="btn" disabled={busy}>{busy ? t("loading") : t("report.send")}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>{t("form.cancel")}</button>
      </div>
    </form>
  );
}
