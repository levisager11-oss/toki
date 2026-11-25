import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { SettingRow, Switch } from "./SettingRow";

/**
 * Whether friends see what the player did (new levels, achievements, best scores, cosmetics,
 * reviews) in their feed. Turning it off also deletes what they could see so far.
 */
export function ShareActivity({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    supabase.from("profiles").select("share_activity").eq("id", userId).maybeSingle().then(({ data }) => {
      if (alive) setOn((data as { share_activity?: boolean } | null)?.share_activity ?? true);
    });
    return () => {
      alive = false;
    };
  }, [userId]);
  const toggle = async () => {
    if (on === null) return;
    setBusy(true);
    setErr(false);
    const { error } = await supabase.from("profiles").update({ share_activity: !on }).eq("id", userId);
    if (error) setErr(true);
    else setOn(!on);
    setBusy(false);
  };
  return (
    <>
      <SettingRow title={t("feed.share")} help={t("feed.shareHelp")} htmlFor="share-activity">
        <Switch id="share-activity" checked={!!on} disabled={on === null || busy} onChange={toggle} />
      </SettingRow>
      {err && <p className="error set-note" role="alert">{t("error")}</p>}
    </>
  );
}
