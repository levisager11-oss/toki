import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { useI18n, type Key } from "../lib/i18n";

/** Which text explains why the new password wasn't saved. */
export function passwordError(message: string): Key {
  const m = message.toLowerCase();
  if (m.includes("different from the old")) return "pw.same";
  if (m.includes("at least") || m.includes("weak") || m.includes("short")) return "signup.passwordHelp";
  if (m.includes("rate") || m.includes("too many")) return "login.resetWait";
  return "error";
}

/** New password, twice. For the logged-in account (also right after opening a reset link). */
export function PasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== again) return setErr(t("pw.mismatch"));
    setErr("");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(t(passwordError(error.message)));
    setPw("");
    setAgain("");
    onDone();
  };

  return (
    <form className="form" onSubmit={submit}>
      <label htmlFor="new-pw">{t("pw.new")}</label>
      <input id="new-pw" type="password" required minLength={8} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="new-pw-help" />
      <small id="new-pw-help">{t("signup.passwordHelp")}</small>
      <label htmlFor="new-pw2">{t("pw.repeat")}</label>
      <input id="new-pw2" type="password" required minLength={8} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("pw.save")}</button>
    </form>
  );
}
