import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";

/**
 * "Get invites on this device": turns push notifications for game invites on or off here.
 * Nothing where the browser can't do it at all.
 */
export function PushSwitch() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    pushState().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);
  if (!userId || !state || state === "unsupported") return null;

  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if (state === "on") {
        await disablePush();
        setState("off");
      } else {
        setState(await enablePush(userId, lang));
      }
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };

  return (
    <div className="push-switch">
      <span>
        <b>{t("push.title")}</b>
        <span className="sub">
          {state === "install" ? t("push.install") : state === "blocked" ? t("push.blocked") : state === "on" ? t("push.on") : t("push.off")}
        </span>
        {failed && <span className="error" role="alert">{t("push.failed")}</span>}
      </span>
      {(state === "on" || state === "off") && (
        <button type="button" className={`btn ${state === "on" ? "" : "primary"}`} onClick={toggle} disabled={busy} aria-pressed={state === "on"}>
          {state === "on" ? t("push.turnOff") : t("push.turnOn")}
        </button>
      )}
    </div>
  );
}
