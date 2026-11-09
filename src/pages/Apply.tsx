import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { apply, APPLY_LIMITS, ApplyError, myApplication, withdraw, type Application } from "../lib/applications";
import { canCreate } from "../lib/types";

/** Applying for a developer account (/apply). */
export function Apply() {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [app, setApp] = useState<Application | null | undefined>(undefined);
  const [about, setAbout] = useState("");
  const [links, setLinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    myApplication().then(setApp).catch(() => setApp(null));
  }, []);
  useEffect(() => {
    document.title = `${t("apply.title")} · Toki`;
    return () => {
      document.title = "Toki";
    };
  }, [t]);

  if (!profile || app === undefined) return <p className="msg" aria-busy="true">{t("loading")}</p>;

  if (canCreate(profile))
    return (
      <section className="panel narrow">
        <h1 className="h">{t("apply.title")}</h1>
        <p className="lead">{t("apply.alreadyDeveloper")}</p>
        <div className="actions">
          <Link to="/add" className="btn primary">{t("nav.addGame")}</Link>
          <Link to="/my-games" className="btn">{t("nav.myGames")}</Link>
        </div>
      </section>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (about.trim().length < APPLY_LIMITS.aboutMin) return setErr(t("apply.err.short"));
    setBusy(true);
    setErr("");
    try {
      setApp(await apply(about, links));
      setSent(true);
    } catch (e) {
      setErr(t(e instanceof ApplyError ? e.key : "error"));
    }
    setBusy(false);
  };
  const takeBack = async () => {
    if (!app) return;
    setBusy(true);
    try {
      await withdraw(app.id);
      setAbout(app.about);
      setLinks(app.links);
      setApp(null);
      setSent(false);
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
  };

  if (app?.status === "pending")
    return (
      <section className="panel narrow apply">
        <h1 className="h">{t("apply.title")}</h1>
        {sent ? <p className="check good" role="status">{t("apply.thanks")}</p> : <p className="lead">{t("apply.pendingHelp")}</p>}
        <div className="apply-sent">
          <p><span className="st st-in_progress">{t("apply.status.pending")}</span> <span className="sub">{t("apply.sent", { when: ago(app.created_at, lang) })}</span></p>
          <h2 className="label">{t("apply.about")}</h2>
          <p className="fb-body">{app.about}</p>
          {app.links && (
            <>
              <h2 className="label">{t("apply.links")}</h2>
              <p className="fb-body">{app.links}</p>
            </>
          )}
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button type="button" className="btn ghost-danger" onClick={takeBack} disabled={busy}>{t("apply.withdraw")}</button>
        </div>
      </section>
    );

  return (
    <section className="panel narrow apply">
      <h1 className="h">{t("apply.title")}</h1>
      <p className="lead">{t("apply.lead")}</p>
      {app?.status === "rejected" && (
        <div className="check warn">
          <p>{t("apply.declined")}</p>
          {app.review_note && <p className="sub">{t("apply.note", { note: app.review_note })}</p>}
        </div>
      )}
      <form className="form" onSubmit={submit}>
        <label htmlFor="about">{t("apply.about")}</label>
        <small id="about-help">{t("apply.aboutHelp")}</small>
        <textarea id="about" rows={6} required minLength={APPLY_LIMITS.aboutMin} maxLength={APPLY_LIMITS.about} value={about} onChange={(e) => setAbout(e.target.value)} aria-describedby="about-help" />
        <label htmlFor="links">{t("apply.links")}</label>
        <small id="links-help">{t("apply.linksHelp")}</small>
        <textarea id="links" rows={3} maxLength={APPLY_LIMITS.links} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://" aria-describedby="links-help" />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? t("fb.form.sending") : t("apply.submit")}</button>
      </form>
      <p className="alt">{t("apply.invite")} <Link to="/account">{t("apply.inviteLink")}</Link></p>
    </section>
  );
}
