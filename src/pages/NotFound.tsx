import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useTitle } from "../lib/useTitle";

export function NotFound() {
  const { t } = useI18n();
  useTitle(t("notFound").replace(/\.$/, ""));
  // Search engines shouldn't list addresses that don't exist.
  useEffect(() => {
    const tag = document.createElement("meta");
    tag.name = "robots";
    tag.content = "noindex";
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);
  return (
    <section className="lost">
      <span className="lost-code" aria-hidden="true">404</span>
      <h1 className="h">{t("notFound")}</h1>
      <p>{t("notFound.text")}</p>
      <Link to="/" className="btn primary">{t("back")}</Link>
    </section>
  );
}
