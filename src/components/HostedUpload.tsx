import { useEffect, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { supabase } from "../lib/supabase";
import { hostError, readPicked, rollBackGame, type PickedFile } from "../lib/hosting";
import { MAX_GAME_BYTES, planFiles } from "../lib/hostingRules";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Files dropped onto the box, folders included (read through the browser's file entries). */
async function droppedFiles(e: DragEvent): Promise<File[]> {
  const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  if (!items.length) return [...e.dataTransfer.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(new File([file], file.name, { type: file.type }));
      Object.defineProperty(out[out.length - 1], "webkitRelativePath", { value: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of items) await walk(entry, "");
  return out;
}

export const mbText = mb;

export interface Picked {
  files: PickedFile[];
  entry: string;
  bytes: number;
}

/**
 * "Upload to Toki" in the game form: pick or drop a ZIP, a folder or one HTML file. The upload
 * itself happens when the form is saved (GameForm), so a new game gets its row first.
 */
export function HostedUpload({ picked, onPick, gameId, hosted, progress }: {
  picked: Picked | null;
  onPick: (p: Picked | null) => void;
  gameId?: string;
  /** The game's current address on Toki, when it is hosted already */
  hosted: string | null;
  /** 0–1 while uploading */
  progress: number | null;
}) {
  const { t } = useI18n();
  const [err, setErr] = useState("");
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);

  const take = async (list: File[]) => {
    setErr("");
    if (!list.length) return;
    setReading(true);
    try {
      const files = await readPicked(list);
      const plan = planFiles(files);
      if ("error" in plan) {
        onPick(null);
        setErr(t(`host.err.${plan.error}`, { mb: mb(MAX_GAME_BYTES) }));
      } else onPick({ files, entry: plan.entry, bytes: plan.bytes });
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: mb(MAX_GAME_BYTES) }));
    }
    setReading(false);
  };

  return (
    <div className="host-box">
      {hosted && !picked && (
        <p className="check good">
          {t("host.live")} <a href={hosted} target="_blank" rel="noreferrer">{hosted.replace(/^https:\/\//, "")}</a>
        </p>
      )}
      <div
        className={`drop${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => { e.preventDefault(); setOver(false); take(await droppedFiles(e)); }}
      >
        <p>{hosted ? t("host.dropNew") : t("host.drop")}</p>
        <div className="actions">
          <label className="btn file">
            {t("host.pickFile")}
            <input type="file" accept=".zip,.html,.htm,application/zip,text/html" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; take(f); }} />
          </label>
          <label className="btn file">
            {t("host.pickFolder")}
            <input type="file" {...{ webkitdirectory: "", directory: "" }} multiple onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; take(f); }} />
          </label>
        </div>
        <small>{t("host.dropHelp", { mb: mb(MAX_GAME_BYTES) })}</small>
      </div>
      {reading && <p className="check" aria-live="polite">{t("host.reading")}</p>}
      {picked && (
        <p className="check good" aria-live="polite">
          {t("host.picked", { n: picked.files.length, size: mb(picked.bytes), entry: picked.entry })}{" "}
          <button type="button" className="linkish" onClick={() => onPick(null)}>{t("host.unpick")}</button>
        </p>
      )}
      {progress !== null && (
        <div className="host-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t("host.uploading")}>
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {gameId && hosted && <Versions gameId={gameId} />}
      <p className="host-more">
        <Link to="/my-games#upload-keys">{t("host.agentLink")}</Link>
      </p>
    </div>
  );
}

interface Build {
  id: string;
  status: "live" | "previous";
  version: string | null;
  live_at: string | null;
  delete_after: string | null;
  bytes: number;
}

/** The live version and the one before it (kept 30 days), with "Roll back". */
function Versions({ gameId }: { gameId: string }) {
  const { t, lang } = useI18n();
  const [builds, setBuilds] = useState<Build[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () =>
    supabase.from("game_builds").select("id,status,version,live_at,delete_after,bytes").eq("game_id", gameId).in("status", ["live", "previous"]).order("created_at", { ascending: false })
      .then(({ data }) => setBuilds((data ?? []) as Build[]));
  useEffect(() => {
    load();
  }, [gameId]);
  const prev = builds.find((b) => b.status === "previous" && b.delete_after && new Date(b.delete_after) > new Date());
  if (!prev) return null;
  const date = (s: string | null) => (s ? new Date(s).toLocaleDateString(lang === "de" ? "de-CH" : "en-GB") : "");
  const back = async () => {
    setBusy(true);
    setMsg("");
    try {
      await rollBackGame(gameId);
      setMsg(t("host.rolledBack"));
      await load();
    } catch (e) {
      setMsg(t(`host.err.${hostError(e)}`, { mb: mb(MAX_GAME_BYTES) }));
    }
    setBusy(false);
  };
  return (
    <div className="host-versions">
      <p>
        {t("host.previous", { date: date(prev.live_at), until: date(prev.delete_after) })}
        {prev.version ? ` (${prev.version})` : ""}
      </p>
      <button type="button" className="btn" onClick={back} disabled={busy}>{t("host.rollBack")}</button>
      {msg && <p className="check" aria-live="polite">{msg}</p>}
    </div>
  );
}
