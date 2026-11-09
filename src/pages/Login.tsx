import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { safeNext } from "../lib/nav";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";

export function Login() {
  const { t } = useI18n();
  useTitle(t("login.title"));
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setErr(error.message.toLowerCase().includes("confirm") ? t("login.notConfirmed") : t("login.failed"));
    else navigate(safeNext(params.get("next")));
  };

  return (
    <section className="panel narrow">
      <h1 className="h">{t("login.title")}</h1>
      <p className="lead">{t("login.subtitle")}</p>
      <form className="form" onSubmit={submit}>
        <label htmlFor="email">{t("login.email")}</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">{t("login.password")}</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("login.submit")}</button>
      </form>
      <p className="alt">{t("login.noAccount")} <Link to={`/signup${location.search}`}>{t("login.signup")}</Link></p>
    </section>
  );
}
