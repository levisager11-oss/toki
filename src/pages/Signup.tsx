import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { safeNext } from "../lib/nav";
import { useTitle } from "../lib/useTitle";
import { useAuth } from "../lib/auth";
import { inlineLinks } from "../lib/inlineLinks";
import { passwordError } from "../components/PasswordForm";
import { isCaptchaError, useCaptcha } from "../lib/captcha";
import { ageOf, bornValue, MIN_AGE, PARENT_AGE, rememberTooYoung, tooYoungHere } from "../lib/account";
import { BirthFields } from "../components/BirthFields";

export function Signup() {
  const { t } = useI18n();
  useTitle(t("signup.title"));
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [parentOk, setParentOk] = useState(false);
  // Too young for an account (now, or on this device in the last days).
  const [tooYoung, setTooYoung] = useState(tooYoungHere);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { session, ready } = useAuth();
  const captcha = useCaptcha();
  // Already logged in: nothing to do here.
  if (ready && session && !busy && !done) return <Navigate to={safeNext(params.get("next"))} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const code = invite.trim();
    const name = username.trim().toLowerCase();
    const born = bornValue(year, month);
    if (!born) return;
    const age = ageOf(born);
    // Under 13: no account, and nothing they typed is sent anywhere.
    if (age < MIN_AGE) {
      rememberTooYoung();
      return setTooYoung(true);
    }
    setBusy(true);
    try {
      if (code) {
        const { data: ok } = await supabase.rpc("check_invite", { p_code: code });
        if (!ok) return setErr(t("signup.badInvite"));
      }
      const { data: taken } = await supabase.from("profiles").select("id").eq("username", name).maybeSingle();
      if (taken) return setErr(t("signup.usernameTaken"));
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { invite: code, username: name, born, parent_ok: age < PARENT_AGE && parentOk }, emailRedirectTo: `${window.location.origin}/login`, captchaToken: await captcha.getToken() },
      });
      if (isCaptchaError(error)) return setErr(t("captcha.failed"));
      if (error) {
        if (/already (registered|exists)/i.test(error.message)) return setErr(t("signup.emailTaken"));
        if (!error.message.includes("Database error")) {
          const key = passwordError(error.message);
          return setErr(key === "error" && /email/i.test(error.message) ? t("signup.badEmail") : t(key));
        }
        // The account couldn't be made: someone took the name just now, or the invite is used up.
        const { data: takenNow } = await supabase.from("profiles").select("id").eq("username", name).maybeSingle();
        return setErr(takenNow || !code ? t("signup.usernameTaken") : t("signup.badInvite"));
      }
      const next = code ? "/my-games" : safeNext(params.get("next"));
      if (data.session) return navigate(next);
      // Accounts are confirmed on creation, so log straight in.
      const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password, options: { captchaToken: await captcha.getToken() } });
      if (loginError) setDone(true);
      else navigate(next);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <section className="panel narrow">
        <h1 className="h">{t("signup.title")}</h1>
        <p className="lead">{t("signup.done")}</p>
        <Link to="/login" className="btn primary">{t("nav.login")}</Link>
      </section>
    );

  if (tooYoung)
    return (
      <section className="panel narrow">
        <h1 className="h">{t("age.tooYoung.title")}</h1>
        <p className="lead">{t("age.tooYoung.text")}</p>
        <Link to="/" className="btn primary">{t("age.playOn")}</Link>
      </section>
    );

  const bornNow = bornValue(year, month);
  const ageNow = bornNow ? ageOf(bornNow) : null;
  const needsParent = ageNow !== null && ageNow >= MIN_AGE && ageNow < PARENT_AGE;

  return (
    <section className="panel narrow">
      <h1 className="h">{t("signup.title")}</h1>
      <p className="lead">{t("signup.subtitle")}</p>
      <form className="form" onSubmit={submit}>
        <label htmlFor="username">{t("signup.username")}</label>
        <input id="username" required pattern="[a-z0-9_]{3,20}" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby="username-help" />
        <small id="username-help">{t("signup.usernameHelp")}</small>
        <label htmlFor="email">{t("login.email")}</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <label htmlFor="password">{t("login.password")}</label>
        <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby="pw-help" />
        <small id="pw-help">{t("signup.passwordHelp")}</small>
        <BirthFields month={month} year={year} onMonth={setMonth} onYear={setYear} />
        {needsParent && (
          <label className="fb-check">
            <input type="checkbox" required checked={parentOk} onChange={(e) => setParentOk(e.target.checked)} />
            <span>{t("age.parentOk")}</span>
          </label>
        )}
        <label htmlFor="invite">{t("signup.invite")}</label>
        <input id="invite" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="invite-help" />
        <small id="invite-help">{t("signup.inviteHelp")}</small>
        {captcha.element}
        {err && (
          <p className="error" role="alert">
            {err}
            {err === t("signup.emailTaken") && <> <Link to="/login?forgot=1">{t("login.forgot")}</Link></>}
          </p>
        )}
        <p className="hint">
          {inlineLinks(t("signup.agree"))}
        </p>
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("signup.submit")}</button>
      </form>
      <p className="alt">{t("signup.haveAccount")} <Link to={`/login${location.search}`}>{t("nav.login")}</Link></p>
    </section>
  );
}
