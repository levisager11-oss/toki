import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { safeNext } from "../lib/nav";
import { useTitle } from "../lib/useTitle";
import { useAuth } from "../lib/auth";
import { passwordError } from "../components/PasswordForm";

export function Signup() {
  const { t } = useI18n();
  useTitle(t("signup.title"));
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { session, ready } = useAuth();
  // Already logged in: nothing to do here.
  if (ready && session && !busy && !done) return <Navigate to={safeNext(params.get("next"))} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const code = invite.trim();
    const name = username.trim().toLowerCase();
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
        options: { data: { invite: code, username: name }, emailRedirectTo: `${window.location.origin}/login` },
      });
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
      const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
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
        <label htmlFor="invite">{t("signup.invite")}</label>
        <input id="invite" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="invite-help" />
        <small id="invite-help">{t("signup.inviteHelp")}</small>
        {err && (
          <p className="error" role="alert">
            {err}
            {err === t("signup.emailTaken") && <> <Link to="/login?forgot=1">{t("login.forgot")}</Link></>}
          </p>
        )}
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("signup.submit")}</button>
      </form>
      <p className="alt">{t("signup.haveAccount")} <Link to={`/login${location.search}`}>{t("nav.login")}</Link></p>
    </section>
  );
}
