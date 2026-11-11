import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { safeNext } from "../lib/nav";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { useAuth } from "../lib/auth";
import { isCaptchaError, useCaptcha } from "../lib/captcha";

export function Login() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { session, ready } = useAuth();
  // "Forgot your password?": the same page asks for the email and sends a reset link.
  const [forgot, setForgot] = useState(params.get("forgot") === "1");
  const [sent, setSent] = useState(false);
  const captcha = useCaptcha(forgot ? "reset" : "login");
  useTitle(forgot ? t("login.resetTitle") : t("login.title"));
  // Already logged in: nothing to do here.
  if (ready && session && !busy) return <Navigate to={safeNext(params.get("next"))} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const captchaToken = await captcha.getToken();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password, options: { captchaToken } });
    setBusy(false);
    if (isCaptchaError(error)) setErr(t("captcha.failed"));
    else if (error) setErr(error.message.toLowerCase().includes("confirm") ? t("login.notConfirmed") : t("login.failed"));
    else navigate(safeNext(params.get("next")));
  };

  const sendReset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const captchaToken = await captcha.getToken();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/reset-password`, captchaToken });
    setBusy(false);
    if (isCaptchaError(error)) return setErr(t("captcha.failed"));
    // Same answer whether or not the email has an account, so nobody can find out who plays here.
    if (error && error.status === 429) return setErr(t("login.resetWait"));
    setSent(true);
  };

  if (forgot)
    return (
      <section className="panel narrow">
        <h1 className="h">{t("login.resetTitle")}</h1>
        {sent ? (
          <p className="check good" role="status">{t("login.resetSent")}</p>
        ) : (
          <>
            <p className="lead">{t("login.resetHelp")}</p>
            <form className="form" onSubmit={sendReset}>
              <label htmlFor="email">{t("login.email")}</label>
              <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              {captcha.element}
              {err && <p className="error" role="alert">{err}</p>}
              <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("login.resetSend")}</button>
            </form>
          </>
        )}
        <p className="alt">
          <button type="button" className="linkish" onClick={() => { setForgot(false); setSent(false); setErr(""); }}>{t("login.resetBack")}</button>
        </p>
      </section>
    );

  return (
    <section className="panel narrow">
      <h1 className="h">{t("login.title")}</h1>
      <p className="lead">{t("login.subtitle")}</p>
      <form className="form" onSubmit={submit}>
        <label htmlFor="email">{t("login.email")}</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">{t("login.password")}</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {captcha.element}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("login.submit")}</button>
      </form>
      <p className="alt"><button type="button" className="linkish" onClick={() => { setForgot(true); setErr(""); }}>{t("login.forgot")}</button></p>
      <p className="alt">{t("login.noAccount")} <Link to={`/signup${location.search}`}>{t("login.signup")}</Link></p>
    </section>
  );
}
