import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="msg">
      <p>{t("notFound")}</p>
      <Link to="/" className="btn">{t("back")}</Link>
    </div>
  );
}
