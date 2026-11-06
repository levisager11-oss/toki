import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";

type Result = "checking" | "ok" | "blocked" | "isolation" | "unreachable" | "failed";
const WAIT_MS = 700;

async function check(url: string, signal: AbortSignal): Promise<Result> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/api/check?url=${encodeURIComponent(url)}`, {
    headers: { authorization: `Bearer ${data.session?.access_token ?? ""}` },
    signal,
  });
  if (!res.ok) return "failed";
  const r = (await res.json()) as { reachable: boolean; framable: boolean; isolation: boolean };
  if (!r.reachable) return "unreachable";
  if (!r.framable) return "blocked";
  return r.isolation ? "ok" : "isolation";
}

/** Tells a member right away whether a game link will work inside Toki, with a live preview. */
export function LinkCheck({ url }: { url: string }) {
  const { t } = useI18n();
  const [result, setResult] = useState<Result | null>(null);
  const [preview, setPreview] = useState(false);
  const valid = /^https:\/\/[^\s/]+\.[^\s]+$/i.test(url);

  useEffect(() => {
    setPreview(false);
    if (!valid) return setResult(null);
    const ctl = new AbortController();
    setResult("checking");
    const id = setTimeout(() => {
      check(url, ctl.signal)
        .then(setResult)
        .catch(() => !ctl.signal.aborted && setResult("failed"));
    }, WAIT_MS);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [url, valid]);

  if (!valid || !result) return null;
  const tone = result === "ok" ? "good" : result === "checking" ? "" : result === "failed" ? "" : "warn";
  return (
    <div className="link-check">
      <p className={`check ${tone}`} role="status">{t(`check.${result}`)}</p>
      {result !== "checking" && result !== "unreachable" && (
        <button type="button" className="linkish" onClick={() => setPreview((p) => !p)}>
          {preview ? t("form.hidePreview") : t("form.showPreview")}
        </button>
      )}
      {preview && (
        <div className="frame preview">
          <iframe src={url} title={t("form.preview")} allow="autoplay; gamepad; cross-origin-isolated; fullscreen" />
        </div>
      )}
    </div>
  );
}
