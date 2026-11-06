import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";

export function Signup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const code = invite.trim();
    const name = username.trim().toLowerCase();
    setBusy(true);
    try {
      const { data: ok } = await supabase.rpc("check_invite", { p_code: code });
      if (!ok) return setErr(t("signup.badInvite"));
      const { data: taken } = await supabase.from("profiles").select("id").eq("username", name).maybeSingle();
      if (taken) return setErr(t("signup.usernameTaken"));
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { invite: code, username: name }, emailRedirectTo: `${window.location.origin}/login` },
      });
      if (error) return setErr(error.message.includes("Database error") ? t("signup.badInvite") : error.message);
      if (data.session) navigate("/my-games");
      else setDone(true);
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
        <label htmlFor="invite">{t("signup.invite")}</label>
        <input id="invite" required value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} />
        <label htmlFor="username">{t("signup.username")}</label>
        <input id="username" required pattern="[a-z0-9_]{3,20}" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" aria-describedby="username-help" />
        <small id="username-help">{t("signup.usernameHelp")}</small>
        <label htmlFor="email">{t("login.email")}</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <label htmlFor="password">{t("login.password")}</label>
        <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby="pw-help" />
        <small id="pw-help">{t("signup.passwordHelp")}</small>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? t("loading") : t("signup.submit")}</button>
      </form>
      <p className="alt">{t("signup.haveAccount")} <Link to="/login">{t("nav.login")}</Link></p>
    </section>
  );
}
