import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";

export function RequireMember({ admin, children }: { admin?: boolean; children: ReactNode }) {
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
  if (!profile || (admin && profile.role !== "admin")) return <p className="msg">{t("auth.noRights")}</p>;
  return <>{children}</>;
}
