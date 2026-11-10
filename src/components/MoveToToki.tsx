import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { ApiError, githubConnectLink, githubManage, githubRepos, type GitHubInfo } from "../lib/ai";
import { checkMove, hostError, moveBack, moveToToki, type MoveCheck, type MoveResult } from "../lib/hosting";
import { guessRepo, MAX_GAME_BYTES, pagesRepos } from "../lib/hostingRules";
import { mbText } from "./HostedUpload";

export type Moved = MoveResult;

/** The developer's GitHub as Toki sees it (null while loading, or when GitHub isn't set up on Toki), and "look again". */
function useGitHub(): [GitHubInfo | null, () => void] {
  const [info, setInfo] = useState<GitHubInfo | null>(null);
  const live = useRef(true);
  const load = () => void githubRepos().then((i) => live.current && setInfo(i), () => {});
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, []);
  return [info?.configured ? info : null, load];
}

/** Off to GitHub to connect it, and back to this game's "Move to Toki" afterwards. */
const connectGitHub = (info: GitHubInfo) => window.location.assign(githubConnectLink(info, `${window.location.pathname}#move`));

type Repo = NonNullable<GitHubInfo["repos"]>[number];
const repoKey = (r: Repo) => `${r.installation_id}:${r.repo}`;

/**
 * The game's repository, for a complete move. With GitHub connected: which repository is the
 * game's (Toki's guess is preselected). Toki takes the game from it when the finished game is in
 * there; when it holds the source, Toki uses its list of files to get every file from the site.
 * Not connected yet: "Connect GitHub to make it complete".
 */
function RepoPicker({ info, reload, value, onChange, hint }: { info: GitHubInfo; reload: () => void; value: string; onChange: (v: string) => void; hint: string | null }) {
  const { t } = useI18n();
  const stop = useRef<() => void>();
  useEffect(() => () => stop.current?.(), []);
  if (!info.installUrl) return null;
  if (!info.installations?.length) {
    return (
      <div className="check move-tip">
        <p>{hint ? t("move.githubTipRepo", { repo: hint }) : t("move.githubTip")}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => connectGitHub(info)}>{t("connect.githubConnect")}</button>
        </div>
      </div>
    );
  }
  const more = () => {
    stop.current?.();
    stop.current = githubManage(info.installUrl!, reload);
  };
  return (
    <div className="move-repo">
      <label htmlFor="move-repo">{t("move.repo")}</label>
      <select id="move-repo" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby="move-repo-help">
        <option value="">{t("move.repoNone")}</option>
        {(info.repos ?? []).map((r) => (
          <option key={repoKey(r)} value={repoKey(r)}>{r.repo}{r.private ? ` (${t("git.private")})` : ""}</option>
        ))}
      </select>
      <small id="move-repo-help">
        {value ? t("move.repoHelp") : hint ? t("move.repoMissing", { repo: hint }) : t("move.repoPick")}{" "}
        <button type="button" className="linkish" onClick={more}>{t("git.moreRepos")}</button>
      </small>
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
 * its GitHub repository when that holds the finished game, else from its link (with the
 * repository's list of files, so nothing is left behind), and hosts it; the game keeps its page,
 * plays, likes and high scores. Players' progress comes along by itself when the game hands it to
 * Toki's save script at its old address (src/lib/movedSaves.ts). Toki stops and asks first when
 * progress would stay behind, or when files might be missing.
 */
export function MoveToToki({ gameId, slug, url, onMoved }: { gameId: string; slug: string; url: string; onMoved: (m: Moved) => void }) {
  const { t } = useI18n();
  const [github, reloadGitHub] = useGitHub();
  const pagesRepo = pagesRepos(url)[0]?.repo ?? null;
  // The game's repository: Toki's guess until the developer picks one ("" = none).
  const [picked, setPicked] = useState<string | null>(null);
  const guess = github?.repos ? guessRepo(github.repos, url, slug) : null;
  const repoValue = picked ?? (guess ? repoKey(guess) : "");
  const repo = github?.repos?.find((r) => repoKey(r) === repoValue) ?? null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Players' progress wouldn't come along: why, and whether the developer accepts it.
  const [problem, setProblem] = useState<"no_script" | "engine_storage" | null>(null);
  const [accept, setAccept] = useState(false);
  // File names the game builds while running, which Toki can't look up without its repository.
  const [dynamic, setDynamic] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Opened from "Move to Toki" on My games, or back from connecting GitHub.
  useEffect(() => {
    if (location.hash === "#move") box.current?.scrollIntoView({ block: "center" });
  }, []);
  const move = async () => {
    setBusy(true);
    setErr("");
    try {
      onMoved(await moveToToki(gameId, { anyway: !!problem && accept, partial: dynamic !== null && partial, repo: repo ? { installation_id: repo.installation_id, repo: repo.repo } : null }));
    } catch (e) {
      const code = hostError(e);
      if (code === "move_no_saves") setProblem("no_script");
      else if (code === "move_engine_saves") setProblem("engine_storage");
      else if (code === "move_dynamic_files") setDynamic(e instanceof ApiError ? e.detail : "");
      else setErr(t(`host.err.${code}`, { mb: mbText(MAX_GAME_BYTES) }));
    }
    setBusy(false);
  };
  const anyway = (!!problem && accept) || (dynamic !== null && !repo && partial);
  return (
    <div className="host-box move-box" id="move" ref={box}>
      <p className="label">{t("move.title")}</p>
      <p>{t("move.help")}</p>
      <small>{t("move.saves")}</small>
      {github && <RepoPicker info={github} reload={reloadGitHub} value={repoValue} onChange={setPicked} hint={pagesRepo} />}
      {problem && <SavesWarning problem={problem} engine={null} accepted={accept} onAccept={setAccept} />}
      {dynamic !== null && !repo && (
        <div className="check warn" role="alert">
          <p>{t("move.dynamic", { names: dynamic || "…" })}</p>
          <p>{github?.installations?.length ? t("move.dynamicPick") : t("move.dynamicConnect")}</p>
          <label className="check">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
            {t("move.dynamicAccept")}
          </label>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn primary" onClick={move} disabled={busy} aria-describedby={busy ? "move-wait" : undefined}>
          {busy ? t("move.busy") : anyway ? t("move.anyway") : problem || (dynamic !== null && !repo) ? t("move.checkAgain") : t("move.button")}
        </button>
      </div>
      {busy && <p className="check" id="move-wait" aria-live="polite">{t("move.wait")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/** Right after moving: where the game is now, where it came from, and the way back to its link. */
export function MovedNotice({ gameId, moved, onUndone }: { gameId: string; moved: Moved; onUndone: () => void }) {
  const { t } = useI18n();
  const [github] = useGitHub();
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
      {moved.source === "site" && moved.repoHelped && <p>{t("move.doneSiteRepo", { repo: moved.repoHelped.repo, n: moved.repoHelped.files })}</p>}
      {moved.source === "site" && <small>{t("move.updatesHow")}</small>}
      {moved.missing.length > 0 && <p className="check warn">{t("move.doneMissing", { names: moved.missing.join(", ") })}</p>}
      {moved.source === "site" && !moved.repoHelped && github && !github.installations?.length && github.installUrl && (
        <div className="check move-tip">
          <p>{moved.suggestRepo ? t("move.githubTipRepo", { repo: moved.suggestRepo }) : t("move.githubTip")}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => connectGitHub(github)}>{t("connect.githubConnect")}</button>
          </div>
        </div>
      )}
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
