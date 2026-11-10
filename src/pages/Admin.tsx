import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { openApplicationCount } from "../lib/applications";
import { useTitle } from "../lib/useTitle";
import { saveIdeaBanner, useIdeaBanner } from "../lib/ideas";

// The admin pages, in one place, so the sidebar needs only one link for them.
const PAGES = [
  { to: "/applications", key: "applications" },
  { to: "/reports", key: "reports" },
  { to: "/invites", key: "invites" },
  { to: "/admin/ai", key: "ai" },
  { to: "/admin/hosting", key: "hosting" },
] as const;

/** Admins: an overview of the admin pages (/admin). */
export function Admin() {
  const { t } = useI18n();
  useTitle(t("nav.admin"));
  const [openApps, setOpenApps] = useState(0);
  useEffect(() => {
    let alive = true;
    openApplicationCount().then((n) => alive && setOpenApps(n));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="panel narrow">
      <h1 className="h">{t("nav.admin")}</h1>
      <p className="lead">{t("admin.lead")}</p>
      <ul className="admin-links">
        {PAGES.map((p) => (
          <li key={p.to}>
            <Link to={p.to}>
              <b>
                {t(`nav.${p.key}`)}
                {p.key === "applications" && openApps > 0 && <span className="count-pill">{openApps}</span>}
              </b>
              <span>{t(`admin.${p.key}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <IdeaBannerSwitch />
    </section>
  );
}

/** Shows or hides "Missing a game you want?" on the home page, for everyone. */
function IdeaBannerSwitch() {
  const { t } = useI18n();
  const shown = useIdeaBanner();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const change = async (on: boolean) => {
    setBusy(true);
    setErr(false);
    try {
      await saveIdeaBanner(on);
    } catch {
      setErr(true);
    }
    setBusy(false);
  };
  return (
    <div className="admin-setting">
      <h2>{t("admin.home")}</h2>
      <label className="check">
        <input type="checkbox" checked={shown === true} disabled={busy || shown === null} onChange={(e) => change(e.target.checked)} />
        <span>
          {t("admin.ideaBanner")}
          <span className="sub">{t("admin.ideaBannerHelp")}</span>
        </span>
      </label>
      {err && <p className="error" role="alert">{t("error")}</p>}
    </div>
  );
}
