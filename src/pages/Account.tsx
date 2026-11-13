import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canCreate } from "../lib/types";
import { SaveHistory } from "../components/SaveHistory";
import { DeveloperCard } from "../components/DeveloperCard";
import { MyFeedback } from "../components/MyFeedback";
import { EditProfile } from "../components/EditProfile";
import { useTitle } from "../lib/useTitle";
import { PasswordForm } from "../components/PasswordForm";
import { AccountData } from "../components/AccountData";

export function Account() {
  const { t } = useI18n();
  useTitle(t("nav.account"));
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  // Just set a new password (from a reset email, or below).
  const [pwSaved, setPwSaved] = useState(params.get("pw") === "1");
  const [pwOpen, setPwOpen] = useState(false);
  if (!profile) return null;

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const { error } = await supabase.rpc("redeem_invite", { p_code: code.trim() });
    setBusy(false);
    if (error) return setErr(t("signup.badInvite"));
    // Load the new role, then go to the creator pages.
    window.location.assign("/my-games");
  };

  return (
    <section className="panel narrow">
      <h1 className="h">@{profile.username}</h1>
      <p className="lead">{t(`account.role.${profile.role}`)}</p>
      {pwSaved && <p className="check good" role="status">{t("pw.saved")}</p>}
      <p>{t("account.saves")}</p>
      <div className="actions">
        <Link to={`/u/${profile.username}`} className="btn">{t("soc.viewProfile")}</Link>
        <Link to="/friends" className="btn">{t("nav.friends")}</Link>
        <Link to="/chat" className="btn">{t("nav.chat")}</Link>
        {profile.role === "admin" && <Link to="/reports" className="btn">{t("nav.reports")}</Link>}
      </div>

      <EditProfile />

      {canCreate(profile) ? (
        <div className="actions" style={{ marginTop: 24 }}>
          <Link to="/my-games" className="btn">{t("nav.myGames")}</Link>
          <Link to="/add" className="btn">{t("nav.addGame")}</Link>
          <Link to="/feedback/inbox" className="btn">{t("fb.inbox.title")}</Link>
        </div>
      ) : (
        <DeveloperCard>
          <form className="form dev-invite" onSubmit={redeem}>
            <label htmlFor="code">{t("account.inviteTitle")}</label>
            <small>{t("account.inviteHelp")}</small>
            <input id="code" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
            {err && <p className="error" role="alert">{err}</p>}
            <button className="btn" disabled={busy}>{busy ? t("loading") : t("account.redeem")}</button>
          </form>
        </DeveloperCard>
      )}

      <SaveHistory />
      <MyFeedback />

      <details className="pw-change" open={pwOpen} onToggle={(e) => setPwOpen(e.currentTarget.open)}>
        <summary>{t("pw.title")}</summary>
        {pwOpen && (
          <PasswordForm
            onDone={() => {
              setPwOpen(false);
              setPwSaved(true);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        )}
      </details>

      <AccountData />

      <div className="actions" style={{ marginTop: 32 }}>
        <button type="button" className="btn" onClick={() => signOut().then(() => navigate("/"))}>{t("nav.logout")}</button>
      </div>
    </section>
  );
}
