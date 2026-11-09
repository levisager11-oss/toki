import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { openApplicationCount } from "../lib/applications";
import { useTitle } from "../lib/useTitle";

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
    </section>
  );
}
