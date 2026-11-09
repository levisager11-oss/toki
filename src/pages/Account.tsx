import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canCreate } from "../lib/types";
import { SaveHistory } from "../components/SaveHistory";
import { MyFeedback } from "../components/MyFeedback";

export function Account() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
      <p>{t("account.saves")}</p>

      {canCreate(profile) ? (
        <div className="actions">
          <Link to="/my-games" className="btn">{t("nav.myGames")}</Link>
          <Link to="/add" className="btn">{t("nav.addGame")}</Link>
          <Link to="/feedback/inbox" className="btn">{t("fb.inbox.title")}</Link>
        </div>
      ) : (
        <form className="form" onSubmit={redeem}>
          <label htmlFor="code">{t("account.inviteTitle")}</label>
          <small>{t("account.inviteHelp")}</small>
          <input id="code" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn" disabled={busy}>{busy ? t("loading") : t("account.redeem")}</button>
        </form>
      )}

      <SaveHistory />
      <MyFeedback />

      <div className="actions" style={{ marginTop: 32 }}>
        <button type="button" className="btn" onClick={() => signOut().then(() => navigate("/"))}>{t("nav.logout")}</button>
      </div>
    </section>
  );
}
