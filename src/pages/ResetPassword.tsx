import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";
import { PasswordForm } from "../components/PasswordForm";

/**
 * Where the "reset your password" email leads. Opening the link logs the player in
 * (Supabase reads it from the address), so here they only choose the new password.
 */
export function ResetPassword() {
  const { t } = useI18n();
  useTitle(t("pw.resetTitle"));
  const { session, ready } = useAuth();
  const navigate = useNavigate();
  // A link that was used already or is too old comes back with an error in the address.
  const [failed] = useState(() => /error/.test(location.hash) || /error/.test(location.search));

  if (!ready) return <p className="msg" aria-busy="true">{t("loading")}</p>;
  if (!session || failed)
    return (
      <section className="panel narrow">
        <h1 className="h">{t("pw.resetTitle")}</h1>
        <div className="msg">
          <p>{t("pw.linkExpired")}</p>
          <Link to="/login?forgot=1" className="btn primary">{t("pw.newLink")}</Link>
        </div>
      </section>
    );
  return (
    <section className="panel narrow">
      <h1 className="h">{t("pw.resetTitle")}</h1>
      <PasswordForm onDone={() => navigate("/account?pw=1", { replace: true })} />
    </section>
  );
}
