import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n, type Key } from "../lib/i18n";
import { canCreate } from "../lib/types";
import { SaveHistory } from "../components/SaveHistory";
import { DeveloperCard } from "../components/DeveloperCard";
import { MyFeedback } from "../components/MyFeedback";
import { EditProfile } from "../components/EditProfile";
import { useTitle } from "../lib/useTitle";
import { PasswordForm } from "../components/PasswordForm";
import { AccountData } from "../components/AccountData";
import { ShareActivity } from "../components/ShareActivity";
import { useCatalog, useLook, useMyProgress } from "../lib/cosmetics";
import { levelProgress } from "../lib/progress";
import { LevelBadge, Name, ThemeBand, Tokens } from "../components/Looks";
import { Avatar } from "../components/Avatar";
import { LinkRow, SettingGroup, SettingRow } from "../components/SettingRow";

const TABS = ["profile", "progress", "games", "settings"] as const;
type Tab = (typeof TABS)[number];

export function Account() {
  const { t } = useI18n();
  useTitle(t("nav.account"));
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Just set a new password (from a reset email, or below).
  const [pwSaved, setPwSaved] = useState(params.get("pw") === "1");
  const [pwOpen, setPwOpen] = useState(false);
  const progress = useMyProgress(profile?.id);
  const look = useLook(profile?.id);
  const catalog = useCatalog();
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : pwSaved ? "settings" : "profile";
  if (!profile) return null;
  const lv = progress ? levelProgress(progress.xp) : null;
  const themeStyle = look?.theme ? catalog?.get(look.theme)?.style : undefined;
  const open = (next: Tab) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set("tab", next);
    n.delete("pw");
    return n;
  }, { replace: true });
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length];
    open(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <section className="panel account">
      <ThemeBand style={themeStyle} className="account-hero">
        <div className="account-head">
          <Avatar person={profile} size={72} />
          <div className="account-who">
            <h1 className="h"><Name person={profile} /></h1>
            <span className="role-chip">{t(`account.tag.${profile.role}` as Key)}</span>
          </div>
          <Link to={`/u/${profile.username}`} className="btn small">{t("soc.viewProfile")}</Link>
          {lv && (
            <Link to="/top" className="account-level" title={t("lv.xp", { xp: progress!.xp })}>
              <LevelBadge level={lv.level} big />
              <span className="lv-bar" aria-hidden="true"><i style={{ width: `${lv.share * 100}%` }} /></span>
              <Tokens n={progress?.tokens} />
              <small>{t("lv.toNext", { n: lv.needed - lv.into })}</small>
            </Link>
          )}
        </div>
      </ThemeBand>

      <div className="tabs account-tabs" role="tablist" aria-label={t("nav.account")}>
        {TABS.map((k, i) => (
          <button key={k} id={`tab-${k}`} type="button" role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`}
            tabIndex={tab === k ? 0 : -1} onClick={() => open(k)} onKeyDown={(e) => onTabKey(e, i)}>
            {t(`account.tab.${k}` as Key)}
          </button>
        ))}
      </div>

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="account-panel">
        {pwSaved && <p className="check good" role="status">{t("pw.saved")}</p>}

        {tab === "profile" && (
          <>
            <SettingGroup>
              <EditProfile />
            </SettingGroup>
            <SettingGroup title={t("account.privacy")}>
              <ShareActivity userId={profile.id} />
            </SettingGroup>
            <SettingGroup title={t("account.looks")}>
              <LinkRow to={`/u/${profile.username}#collection`} title={t("account.wear")} help={t("account.wearHelp")} />
              <LinkRow to="/shop" title={t("nav.shop")} help={t("account.shopHelp")} extra={<Tokens n={progress?.tokens} />} />
            </SettingGroup>
          </>
        )}

        {tab === "progress" && (
          <>
            <SettingGroup>
              <LinkRow to="/top" title={t("nav.top")} help={t("account.topHelp")} extra={lv && <LevelBadge level={lv.level} />} />
              <LinkRow to="/trades" title={t("nav.trades")} help={t("account.tradesHelp")} />
              <LinkRow to="/feed" title={t("nav.feed")} help={t("account.feedHelp")} />
            </SettingGroup>
            <div className="set-group"><SaveHistory /></div>
            <div className="set-group"><MyFeedback /></div>
          </>
        )}

        {tab === "games" && (canCreate(profile) ? (
          <SettingGroup>
            <LinkRow to="/my-games" title={t("nav.myGames")} help={t("account.myGamesHelp")} />
            <LinkRow to="/add" title={t("nav.addGame")} help={t("account.addHelp")} />
            <LinkRow to="/feedback/inbox" title={t("fb.inbox.title")} help={t("account.inboxHelp")} />
            {profile.role === "admin" && <LinkRow to="/reports" title={t("nav.reports")} help={t("account.reportsHelp")} />}
          </SettingGroup>
        ) : (
          <RedeemInvite />
        ))}

        {tab === "settings" && (
          <>
            <SettingGroup>
              <SettingRow
                title={t("pw.title")}
                help={t("account.pwHelp")}
                below={pwOpen && (
                  <PasswordForm
                    onDone={() => {
                      setPwOpen(false);
                      setPwSaved(true);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  />
                )}
              >
                {!pwOpen && <button type="button" className="btn small" onClick={() => { setPwOpen(true); setPwSaved(false); }}>{t("account.change")}</button>}
              </SettingRow>
              <LinkRow to="/notifications" title={t("account.notifications")} help={t("account.notificationsHelp")} />
            </SettingGroup>
            <SettingGroup title={t("data.title")}>
              <AccountData />
            </SettingGroup>
            <SettingGroup>
              <SettingRow title={t("nav.logout")} help={t("account.logoutHelp")}>
                <button type="button" className="btn small" onClick={() => signOut().then(() => navigate("/"))}>{t("nav.logout")}</button>
              </SettingRow>
            </SettingGroup>
          </>
        )}
      </div>
    </section>
  );
}

/** For players: become a developer with an invite code, or apply. */
function RedeemInvite() {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
    <DeveloperCard>
      <form className="form dev-invite" onSubmit={redeem}>
        <label htmlFor="code">{t("account.inviteTitle")}</label>
        <small>{t("account.inviteHelp")}</small>
        <input id="code" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? t("loading") : t("account.redeem")}</button>
      </form>
    </DeveloperCard>
  );
}
