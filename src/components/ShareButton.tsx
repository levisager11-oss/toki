import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { SITE_URL } from "../lib/site";
import { ShareIcon } from "./icons";

/** Opens the phone's share sheet, or copies the link (and says so) where there is none. */
export function ShareButton({ path, title, text, className = "btn" }: { path: string; title: string; text?: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const share = async () => {
    const url = `${SITE_URL}${path}`;
    if (navigator.share) {
      // The share sheet throws when the visitor closes it; nothing to do then.
      await navigator.share({ title, text, url }).catch(() => {});
      return;
    }
    // Only say "copied" when it was.
    const ok = await navigator.clipboard?.writeText(text ? `${text} ${url}` : url).then(() => true, () => false);
    if (!ok) return void window.prompt(t("game.share"), url);
    setCopied(true);
  };

  return (
    <button type="button" className={className} onClick={share} aria-live="polite">
      <ShareIcon />{copied ? t("game.copied") : t("game.share")}
    </button>
  );
}
