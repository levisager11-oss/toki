import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { githubInstallLink, githubRepos, type GitHubInfo } from "../lib/ai";
import { checkMove, GITHUB_RETURN_KEY, hostError, moveBack, moveToToki, type MoveCheck, type MoveResult } from "../lib/hosting";
import { MAX_GAME_BYTES, pagesRepos } from "../lib/hostingRules";
import { mbText } from "./HostedUpload";

export type Moved = MoveResult;

/** The developer's GitHub as Toki sees it (null while loading, or when GitHub isn't set up on Toki). */
function useGitHub(): GitHubInfo | null {
  const [info, setInfo] = useState<GitHubInfo | null>(null);
  useEffect(() => {
    let live = true;
    githubRepos().then((i) => live && setInfo(i), () => {});
    return () => {
      live = false;
    };
  }, []);
  return info?.configured ? info : null;
}

/** Off to GitHub to connect it, and back to this game's "Move to Toki" afterwards. */
function connectGitHub(info: GitHubInfo) {
  try {
    sessionStorage.setItem(GITHUB_RETURN_KEY, `${window.location.pathname}#move`);
  } catch {
    /* comes back to Toki Connect instead */
  }
  window.location.assign(githubInstallLink(info.installUrl!));
}

const reaches = (info: GitHubInfo | null, repo: string | null) => !!repo && !!info?.repos?.some((r) => r.repo.toLowerCase() === repo.toLowerCase());

/**
 * "Connect GitHub to make it complete": with the repository connected, Toki takes the game straight
 * from it (exactly its files) and every push updates the game. Names the repository when the
 * game's address shows it (GitHub Pages).
 */
function GitHubTip({ info, repo }: { info: GitHubInfo; repo: string | null }) {
  const { t } = useI18n();
  if (reaches(info, repo)) return <p className="check good">{t("move.fromRepo", { repo: repo! })}</p>;
  if (!info.installUrl) return null;
  return (
    <div className="check move-tip">
      <p>{repo ? t("move.githubTipRepo", { repo }) : t("move.githubTip")}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={() => connectGitHub(info)}>{t("connect.githubConnect")}</button>
      </div>
    </div>
  );
}

/** Why players' progress wouldn't come along, how to fix it, and "I understand". */
function SavesWarning({ problem, engine, accepted, onAccept }: {
  problem: NonNullable<MoveCheck["problem"]>;
  engine: MoveCheck["engine"];
  accepted: boolean;
  onAccept: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const e = engine ?? "Godot / Unity";
  return (
    <div className="check warn" role="alert">
      {problem === "engine_storage" ? (
        <>
          <p>{t("move.engineSaves", { engine: e })}</p>
          <p>{t("move.engineSavesHow", { engine: e })}</p>
        </>
      ) : problem === "unreachable" ? (
        <p>{t("move.unreachableSaves")}</p>
      ) : (
        <>
          <p>{t("move.noSaves")}</p>
          <p>{t("move.noSavesHow")}</p>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={accepted} onChange={(ev) => onAccept(ev.target.checked)} />
        {problem === "engine_storage" ? t("move.acceptEngine") : t("move.accept")}
      </label>
    </div>
  );
}

/**
 * In the form of a game that runs at a link elsewhere: "Move to Toki". Toki takes the game from
 * its GitHub repository when that holds the finished game, else from its link, and hosts it; the
 * game keeps its page, plays, likes and high scores. Players' progress comes along by itself when
 * the game hands it to Toki's save script at its old address (src/lib/movedSaves.ts); otherwise
 * moving needs an explicit "move anyway".
 */
export function MoveToToki({ gameId, url, onMoved }: { gameId: string; url: string; onMoved: (m: Moved) => void }) {
  const { t } = useI18n();
  const github = useGitHub();
  const repo = pagesRepos(url)[0]?.repo ?? null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Players' progress wouldn't come along: why, and whether the developer accepts it.
  const [problem, setProblem] = useState<"no_script" | "engine_storage" | null>(null);
  const [accept, setAccept] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Opened from "Move to Toki" on My games, or back from connecting GitHub.
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
      if (code === "move_no_saves") setProblem("no_script");
      else if (code === "move_engine_saves") setProblem("engine_storage");
      else setErr(t(`host.err.${code}`, { mb: mbText(MAX_GAME_BYTES) }));
    }
    setBusy(false);
  };
  return (
    <div className="host-box move-box" id="move" ref={box}>
      <p className="label">{t("move.title")}</p>
      <p>{t("move.help")}</p>
      <small>{t("move.saves")}</small>
      {github && <GitHubTip info={github} repo={repo} />}
      {problem && <SavesWarning problem={problem} engine={null} accepted={accept} onAccept={setAccept} />}
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => move()} disabled={busy} aria-describedby={busy ? "move-wait" : undefined}>
          {busy ? t("move.busy") : problem ? t("move.checkAgain") : t("move.button")}
        </button>
        {problem && accept && <button type="button" className="btn danger" onClick={() => move(true)} disabled={busy}>{t("move.anyway")}</button>}
      </div>
      {busy && <p className="check" id="move-wait" aria-live="polite">{t("move.wait")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/** Right after moving: where the game is now, where it came from, and the way back to its link. */
export function MovedNotice({ gameId, moved, onUndone }: { gameId: string; moved: Moved; onUndone: () => void }) {
  const { t } = useI18n();
  const github = useGitHub();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const undo = async () => {
    setBusy(true);
    setErr("");
    try {
      await moveBack(gameId);
      onUndone();
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: mbText(MAX_GAME_BYTES) }));
    }
    setBusy(false);
  };
  return (
    <div className="host-box move-box" aria-live="polite">
      <p className="check good">
        {t("move.done", { n: moved.files, size: mbText(moved.bytes) })}{" "}
        <a href={moved.play_url} target="_blank" rel="noreferrer">{moved.play_url.replace(/^https:\/\//, "")}</a>
      </p>
      {moved.source === "github" && moved.github && <p>{t("move.doneGithub", { repo: moved.github.repo, branch: moved.github.branch })}</p>}
      {moved.source === "site" && github && <GitHubTip info={github} repo={moved.suggestRepo} />}
      <small>{moved.saves ? t("move.keepOld") : t("move.savesStayed")}</small>
      <small>{t("move.checkIt")}</small>
      <div className="actions">
        <button type="button" className="btn" onClick={undo} disabled={busy}>{t("move.undo")}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/**
 * In the form, when a game that runs at a link elsewhere gets an upload or a repository instead:
 * checks whether players' progress can come along from the old address. onReady(true) once it
 * can, or once the developer accepted that it stays behind.
 */
export function MoveSavesCheck({ gameId, mode, onReady }: { gameId: string; mode: "upload" | "github"; onReady: (ready: boolean) => void }) {
  const { t } = useI18n();
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const [accept, setAccept] = useState(false);
  useEffect(() => {
    let live = true;
    checkMove(gameId).then(
      (c) => live && setCheck(c),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [gameId]);
  const problem = failed ? "unreachable" : check?.problem ?? null;
  const ready = (!!check || failed) && (!problem || accept);
  useEffect(() => onReady(ready), [ready]);
  return (
    <div className="host-box move-box">
      <p className="label">{t("move.savesTitle")}</p>
      {!check && !failed && <p className="check" aria-live="polite">{t("move.checking")}</p>}
      {check?.ok && <p className="check good">{t("move.savesOk")}</p>}
      {problem && <SavesWarning problem={problem} engine={check?.engine ?? null} accepted={accept} onAccept={setAccept} />}
      {check?.github && mode === "upload" && <p className="check">{t("move.repoFound", { repo: check.github.repo })}</p>}
    </div>
  );
}
