import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { setFollowNotify, type FollowInfo } from "../lib/reviews";
import { BellIcon } from "./icons";

/**
 * A bell toggle next to the Follow button: get a notification when the developer releases a new
 * game or a big update. Only shows while the player follows the developer.
 */
export function FollowNotify({ devId, info, onChange }: { devId: string; info: Pick<FollowInfo, "following" | "notify"> | null; onChange?: (notify: boolean) => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(info?.notify ?? true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(info?.notify ?? true), [info?.notify, devId]);
  if (!info?.following) return null;

  const toggle = async () => {
    const next = !on;
    setBusy(true);
    setOn(next);
    try {
      await setFollowNotify(devId, next);
      onChange?.(next);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className={`btn follow-notify ${on ? "on" : ""}`} aria-pressed={on} title={t("fol.notifyHelp")} disabled={busy} onClick={toggle}>
      <BellIcon />
      <span>{on ? t("fol.notifyOn") : t("fol.notify")}</span>
    </button>
  );
}
