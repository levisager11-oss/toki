import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";

interface Version {
  id: number;
  game_id: string;
  kind: "earlier" | "conflict";
  saved_at: string;
}

/** Earlier versions of the player's game progress, so a bad overwrite can be undone. */
export function SaveHistory() {
  const { t, lang } = useI18n();
  const { games } = useGames();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    supabase
      .from("game_save_history")
      .select("id, game_id, kind, saved_at")
      .order("saved_at", { ascending: false })
      .limit(60)
      .then(({ data }) => setVersions((data as Version[] | null) ?? []));
  }, [restored]);

  const restore = async (id: number) => {
    setErr(false);
    setBusy(id);
    const { error } = await supabase.rpc("restore_game_save", { p_id: id });
    setBusy(null);
    if (error) return setErr(true);
    setRestored(id);
  };

  if (!versions) return null;
  const title = (gameId: string) => games?.find((g) => g.id === gameId)?.title ?? "…";
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "de" ? "de-CH" : "en", { dateStyle: "medium", timeStyle: "short" });
  const byGame = [...new Set(versions.map((v) => v.game_id))];

  return (
    <section className="save-history">
      <h2>{t("history.title")}</h2>
      <p className="hint">{t("history.help")}</p>
      {restored !== null && <p className="check good" role="status">{t("history.restored")}</p>}
      {err && <p className="error" role="alert">{t("error")}</p>}
      {byGame.length === 0 && <p className="hint">{t("history.empty")}</p>}
      {byGame.map((gameId) => (
        <div key={gameId}>
          <h3>{title(gameId)}</h3>
          <ul>
            {versions.filter((v) => v.game_id === gameId).map((v) => (
              <li key={v.id}>
                <span>{when(v.saved_at)} · {t(`history.${v.kind}`)}</span>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => restore(v.id)}>{t("history.restore")}</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
