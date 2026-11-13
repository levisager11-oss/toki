import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { deleteAccount, exportMyData, saveFile } from "../lib/account";
import { stopAccountSaves } from "../lib/saves";
import { forgetPush } from "../lib/push";
import { supabase } from "../lib/supabase";

/** On the account page: download everything Toki keeps about you, or delete the account. */
export function AccountData() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const [busy, setBusy] = useState<"" | "export" | "delete">("");
  const [err, setErr] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  if (!profile) return null;

  const download = async () => {
    setBusy("export");
    setErr("");
    try {
      saveFile(`toki-${profile.username}.json`, JSON.stringify(await exportMyData(), null, 2));
    } catch {
      setErr(t("error"));
    }
    setBusy("");
  };

  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim().toLowerCase() !== profile.username) return;
    setBusy("delete");
    setErr("");
    try {
      stopAccountSaves(); // nothing goes up to the account any more
      await forgetPush().catch(() => {});
      await deleteAccount(profile);
      // The account is gone: forget the login on this device and start over as a visitor.
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
      window.location.assign("/");
    } catch (e) {
      setErr(t(e instanceof Error && e.message.includes("last_admin") ? "data.lastAdmin" : "error"));
      setBusy("");
    }
  };

  return (
    <section className="account-data">
      <h2 className="h small">{t("data.title")}</h2>
      <p>{t("data.text")} <Link to="/privacy">{t("data.privacy")}</Link></p>
      <div className="actions">
        <button type="button" className="btn" onClick={download} disabled={!!busy}>{busy === "export" ? t("loading") : t("data.download")}</button>
        {!deleting && <button type="button" className="btn ghost-danger" onClick={() => setDeleting(true)}>{t("data.delete")}</button>}
      </div>
      {deleting && (
        <form className="form" onSubmit={remove}>
          <p className="check warn">{t("data.deleteWarn")}</p>
          <label htmlFor="delete-name">{t("data.typeName", { name: profile.username })}</label>
          <input id="delete-name" required value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <div className="actions">
            <button className="btn danger" disabled={!!busy || typed.trim().toLowerCase() !== profile.username}>{busy === "delete" ? t("loading") : t("data.deleteNow")}</button>
            <button type="button" className="btn" onClick={() => { setDeleting(false); setTyped(""); }}>{t("form.cancel")}</button>
          </div>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}
