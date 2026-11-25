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
import { ShareActivity } from "../components/ShareActivity";
import { useMyProgress } from "../lib/cosmetics";
import { levelProgress } from "../lib/progress";
import { LevelBadge, Tokens } from "../components/Looks";
import { Avatar } from "../components/Avatar";

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
  const progress = useMyProgress(profile?.id);
  if (!profile) return null;
  const lv = progress ? levelProgress(progress.xp) : null;

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
    <section className="panel account">
      <header className="account-head">
        <Avatar person={profile} size={64} />
        <div className="account-who">
          <h1 className="h">@{profile.username}</h1>
          <p className="sub">{t(`account.role.${profile.role}`)}</p>
        </div>
        <Link to={`/u/${profile.username}`} className="btn small">{t("soc.viewProfile")}</Link>
        {lv && (
          <div className="account-level">
            <LevelBadge level={lv.level} big />
            <span className="lv-bar" aria-hidden="true"><i style={{ width: `${lv.share * 100}%` }} /></span>
            <Tokens n={progress?.tokens} />
            <small className="sub">{t("lv.toNext", { n: lv.needed - lv.into })}</small>
            <span className="account-links">
              <Link to="/shop">{t("nav.shop")}</Link>
              <Link to="/trades">{t("nav.trades")}</Link>
              {profile.role === "admin" && <Link to="/reports">{t("nav.reports")}</Link>}
            </span>
          </div>
        )}
      </header>
      {pwSaved && <p className="check good" role="status">{t("pw.saved")}</p>}

      <div className="account-card">
        <EditProfile />
        <ShareActivity userId={profile.id} />
      </div>

      {canCreate(profile) ? (
        <div className="account-card">
          <h2>{t("account.games")}</h2>
          <div className="actions">
            <Link to="/my-games" className="btn">{t("nav.myGames")}</Link>
            <Link to="/add" className="btn">{t("nav.addGame")}</Link>
            <Link to="/feedback/inbox" className="btn">{t("fb.inbox.title")}</Link>
          </div>
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

      <div className="account-card">
        <SaveHistory />
      </div>
      <div className="account-card">
        <MyFeedback />
      </div>

      <div className="account-card">
        <h2>{t("account.settings")}</h2>
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
        <div className="actions">
          <button type="button" className="btn" onClick={() => signOut().then(() => navigate("/"))}>{t("nav.logout")}</button>
        </div>
      </div>
    </section>
  );
}
