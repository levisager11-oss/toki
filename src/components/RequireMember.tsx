import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canCreate } from "../lib/types";

/** For pages only creators (or with `admin`, only admins) can use. `player` lets any logged-in account in. */
export function RequireMember({ admin, player, children }: { admin?: boolean; player?: boolean; children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const { t } = useI18n();
  if (loading) return <p className="msg">{t("loading")}</p>;
  if (!session)
    return (
      <div className="msg">
        <p>{t("auth.required")}</p>
        <Link to="/login" className="btn primary">{t("nav.login")}</Link>
      </div>
    );
  if (!profile) return <p className="msg">{t("auth.noRights")}</p>;
  const allowed = admin ? profile.role === "admin" : player || canCreate(profile);
  if (!allowed && !admin)
    return (
      <div className="msg">
        <p>{t("auth.notDeveloper")}</p>
        <Link to="/apply" className="btn primary">{t("apply.title")}</Link>
      </div>
    );
  if (!allowed) return <p className="msg">{t("auth.noRights")}</p>;
  return <>{children}</>;
}
