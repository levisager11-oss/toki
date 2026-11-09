import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { myApplication, type Application } from "../lib/applications";

/** On a player's account page: how to become a developer, or where their application stands. */
export function DeveloperCard({ children }: { children?: ReactNode }) {
  const { t, lang } = useI18n();
  const [app, setApp] = useState<Application | null | undefined>(undefined);

  useEffect(() => {
    myApplication().then(setApp).catch(() => setApp(null));
  }, []);

  if (app === undefined) return null;
  return (
    <section className="dev-card" aria-labelledby="dev-card-h">
      <h2 id="dev-card-h">{t("apply.cardTitle")}</h2>
      {app?.status === "pending" ? (
        <>
          <p><span className="st st-in_progress">{t("apply.status.pending")}</span> <span className="sub">{t("apply.sent", { when: ago(app.created_at, lang) })}</span></p>
          <p className="hint">{t("apply.pendingHelp")}</p>
          <Link to="/apply" className="btn">{t("apply.view")}</Link>
        </>
      ) : (
        <>
          {app?.status === "rejected" && (
            <div className="check warn">
              <p>{t("apply.declined")}</p>
              {app.review_note && <p className="sub">{t("apply.note", { note: app.review_note })}</p>}
            </div>
          )}
          <p className="hint">{t("apply.cardText")}</p>
          <Link to="/apply" className="btn primary">{app?.status === "rejected" ? t("apply.again") : t("apply.cta")}</Link>
        </>
      )}
      {children}
    </section>
  );
}
