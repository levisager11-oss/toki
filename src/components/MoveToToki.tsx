import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { hostError, moveBack, moveToToki } from "../lib/hosting";
import { MAX_GAME_BYTES } from "../lib/hostingRules";
import { mbText } from "./HostedUpload";

export interface Moved {
  play_url: string;
  from: string;
  files: number;
  bytes: number;
  /** Players' progress comes along */
  saves: boolean;
}

const isGitHubPages = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().endsWith(".github.io");
  } catch {
    return false;
  }
};

/**
 * In the form of a game that runs at a link elsewhere: "Move to Toki". Toki downloads the game
 * from its link and hosts it; the game keeps its page, plays, likes and high scores. Players'
 * progress comes along by itself when the game has Toki's save script at its old address
 * (src/lib/movedSaves.ts); without it, moving needs an explicit "move anyway".
 */
export function MoveToToki({ gameId, url, onMoved }: { gameId: string; url: string; onMoved: (m: Moved) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The game at its link doesn't hand its saves to Toki: players' progress would stay behind.
  const [noSaves, setNoSaves] = useState(false);
  const [accept, setAccept] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Opened from "Move to Toki" on My games.
  useEffect(() => {
    if (location.hash === "#move") box.current?.scrollIntoView({ block: "center" });
  }, []);
  const move = async (anyway = false) => {
    setBusy(true);
    setErr("");
    try {
      onMoved(await moveToToki(gameId, anyway));
    } catch (e) {
      const code = hostError(e);
      if (code === "move_no_saves") setNoSaves(true);
      else setErr(t(`host.err.${code}`, { mb: mbText(MAX_GAME_BYTES) }));
    }
    setBusy(false);
  };
  return (
    <div className="host-box move-box" id="move" ref={box}>
      <p className="label">{t("move.title")}</p>
      <p>{t("move.help")}</p>
      <small>{t("move.saves")}</small>
      {isGitHubPages(url) && <p className="check">{t("move.github")}</p>}
      {noSaves ? (
        <div className="check warn" role="alert">
          <p>{t("move.noSaves")}</p>
          <p>{t("move.noSavesHow")}</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => move()} disabled={busy}>{busy ? t("move.busy") : t("move.checkAgain")}</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            {t("move.accept")}
          </label>
          {accept && (
            <div className="actions">
              <button type="button" className="btn danger" onClick={() => move(true)} disabled={busy}>{t("move.anyway")}</button>
            </div>
          )}
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => move()} disabled={busy} aria-describedby={busy ? "move-wait" : undefined}>
            {busy ? t("move.busy") : t("move.button")}
          </button>
        </div>
      )}
      {busy && <p className="check" id="move-wait" aria-live="polite">{t("move.wait")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/** Right after moving: where the game is now, and the way back to its link if it doesn't work. */
export function MovedNotice({ gameId, moved, onUndone }: { gameId: string; moved: Moved; onUndone: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const undo = async () => {
    setBusy(true);
    setErr("");
    try {
      await moveBack(gameId);
      onUndone();
    } catch {
      setErr(t("host.err.error"));
    }
    setBusy(false);
  };
  return (
    <div className="host-box move-box" aria-live="polite">
      <p className="check good">
        {t("move.done", { n: moved.files, size: mbText(moved.bytes) })}{" "}
        <a href={moved.play_url} target="_blank" rel="noreferrer">{moved.play_url.replace(/^https:\/\//, "")}</a>
      </p>
      <small>{moved.saves ? t("move.keepOld") : t("move.savesStayed")}</small>
      <small>{t("move.checkIt")}</small>
      <div className="actions">
        <button type="button" className="btn" onClick={undo} disabled={busy}>{t("move.undo")}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
