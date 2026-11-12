import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n, listOf } from "../lib/i18n";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { slugify } from "../lib/games";
import { invalidateGames } from "../lib/useGames";
import { coverFor } from "../pixel/scenes";
import { CATEGORIES, type Category } from "../lib/types";
import { siteFor, siteUrl } from "../lib/hostingRules";
import { ApiError, connectError, runJob, type ConnectJob } from "../lib/ai";
import {
  type BuildSetup,
  gitConnect, hostError, scanRepo, scanSample, scanUpload, startAdditions, uploadGame, type GitChoice, type HostingStatus, type Proposal, type ScanResult,
} from "../lib/hosting";
import { HostedUpload, type Picked } from "./HostedUpload";
import { BuildInfo, GitHubFollow, gitFailed } from "./GitHubFollow";

type Phase = "pick" | "scanning" | "review" | "publishing" | "done";
type Step = "create" | "files" | "leaderboard";
type StepState = "wait" | "busy" | "ok" | "skip" | "fail";

/**
 * "Add your game" in one go: drop the game or pick a GitHub repository, Toki's AI reads it and
 * proposes its page, and one button puts it live (and lets the AI add leaderboard support).
 */
/** What the one-click screen hands to the full form ("Advanced"), so nothing is lost. */
export interface QuickCarry {
  proposal: Proposal | null;
  picked: Picked | null;
  git: GitChoice | null;
  kind: "upload" | "github";
}

export function QuickAdd({ hosting, onManual }: { hosting: HostingStatus; onManual: (carry: QuickCarry) => void }) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("pick");
  const [kind, setKind] = useState<"upload" | "github">("upload");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [git, setGit] = useState<GitChoice | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [p, setP] = useState<Proposal | null>(null);
  const [leaderboard, setLeaderboard] = useState(false);
  // Friend invites for a game with online rooms, added by the AI in the same run as the leaderboard.
  const [invites, setInvites] = useState(false);
  // Saves for a game that keeps its progress outside localStorage: the AI adds a copy there.
  const [savesAi, setSavesAi] = useState(false);
  const [err, setErr] = useState("");
  // The repository holds the source: GitHub Actions builds it, after its build file is merged.
  const [building, setBuilding] = useState<(BuildSetup & { repo: string; branch: string }) | null>(null);
  const [steps, setSteps] = useState<Record<Step, StepState>>({ create: "wait", files: "wait", leaderboard: "wait" });
  const [pct, setPct] = useState(0);
  const [game, setGame] = useState<{ id: string; slug: string } | null>(null);
  const [job, setJob] = useState<ConnectJob | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const codeAi = hosting.quickCode ?? "off";

  // ---------- 1. read the game ----------

  const read = async (result: Promise<ScanResult>) => {
    setErr("");
    setPhase("scanning");
    try {
      const r = await result;
      if (!alive.current) return;
      setScan(r);
      setP(r.proposal);
      setLeaderboard(r.proposal.leaderboard && !r.proposal.has_scores && codeAi !== "off");
      setInvites(r.proposal.multiplayer && !r.proposal.has_rooms && codeAi !== "off");
      setSavesAi(!!r.proposal.saves_elsewhere && codeAi !== "off");
      if (r.folder !== null && git) setGit({ ...git, folder: r.folder });
      setPhase("review");
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
      setPhase("pick");
    }
  };

  const onPick = async (x: Picked | null) => {
    setPicked(x);
    if (!x) return;
    const top = x.files[0]?.path.split("/")[0] ?? "";
    const label = x.files.every((f) => f.path.startsWith(`${top}/`)) ? top : x.entry;
    read(scanSample(x.files, x.entry).then((sample) => scanUpload(label, x.files, sample)));
  };

  // ---------- 2. publish ----------

  const set = (s: Step, v: StepState) => setSteps((all) => ({ ...all, [s]: v }));

  const publish = async () => {
    if (!p || !profile || !hosting.domain) return;
    setErr("");
    setPhase("publishing");
    // The game's page first (a free address: "snake", else "snake-2", …).
    set("create", "busy");
    const base = slugify(p.title) || "game";
    let row: { id: string; slug: string } | null = null;
    for (let n = 1; n <= 9 && !row; n++) {
      const slug = n === 1 ? base : `${base.slice(0, 37)}-${n}`;
      const { data, error } = await supabase
        .from("games")
        .insert({
          slug, title: p.title, description: p.description, description_de: p.description_de || null, controls: p.controls, controls_de: p.controls_de || null, category: p.category,
          engine: p.engine || null, cover: coverFor(slug, null), play_url: siteUrl(siteFor(slug), hosting.domain), needs_isolation: p.isolation,
          score_order: p.score_order, score_format: p.score_format, multiplayer: p.multiplayer, screenshots: [], created_by: profile.id,
        })
        .select("id, slug")
        .single();
      if (data) row = data as { id: string; slug: string };
      else if (error?.code !== "23505") break;
    }
    if (!row) {
      set("create", "fail");
      setErr(t("form.error"));
      return setPhase("review");
    }
    set("create", "ok");
    setGame(row);
    invalidateGames();

    // The files: uploaded, or the branch's newest version from GitHub.
    set("files", "busy");
    try {
      if (kind === "upload" && picked) await uploadGame(row.id, picked.files, p.isolation, (d, total) => setPct(d / total));
      else if (git) {
        const r = await gitConnect(row.id, git);
        if (!r.ok) throw new Error(r.error === "cant_build" ? gitFailed(t, r.error, r.engine) : r.error ?? "error");
        // The repository holds the source: GitHub Actions builds it, once its build file is in.
        if (r.building) setBuilding({ ...r.building, repo: git.repo, branch: git.branch });
      }
      set("files", "ok");
    } catch (e) {
      set("files", "fail");
      // A file that didn't reach Cloudflare is "upload"; GitHub deploys say what went wrong.
      const code = e instanceof ApiError ? e.message : kind === "github" && e instanceof Error ? e.message : "upload";
      setErr(hostError(code) === "error" && kind === "github" && code !== "error" ? code : t(`host.err.${hostError(code)}`, { mb: "100 MB" }));
      set("leaderboard", "skip");
      invalidateGames();
      return setPhase("done");
    }
    invalidateGames();

    // A leaderboard and friend invites: Toki Connect changes the code in one run (a new live
    // version, or one pull request).
    const features = [
      ...(savesAi && p.saves_elsewhere ? (["saves"] as const) : []),
      ...(leaderboard ? (["scores"] as const) : []),
      ...(invites && p.multiplayer ? (["multiplayer"] as const) : []),
    ];
    if (!features.length) {
      set("leaderboard", "skip");
      return setPhase("done");
    }
    setPhase("done");
    set("leaderboard", "busy");
    try {
      const started = await startAdditions(
        kind === "upload" || !git
          ? { source: "upload", game_id: row.id, lang, features }
          : { source: "github", game_id: row.id, lang, features, installation_id: git.installation_id, repo: git.repo, branch: git.branch },
      );
      let j = started.job as ConnectJob;
      // Take the run's steps while this page is open; questions are answered on the run's page.
      for (let i = 0; i < 30 && alive.current && j.status === "working"; i++) {
        setJob(j);
        j = await runJob(j.id);
      }
      if (!alive.current) return;
      setJob(j);
      set("leaderboard", j.status === "done" ? "ok" : j.status === "failed" ? "fail" : "busy");
    } catch (e) {
      set("leaderboard", "fail");
      setJob(null);
      setErr(t(`connect.err.${connectError(e instanceof Error ? e.message : "")}`));
    }
  };

  /** The full form, with everything picked or proposed so far. */
  const advanced = () => onManual({ proposal: p, picked, git, kind });

  // ---------- screens ----------

  if (phase === "pick" || phase === "scanning") {
    return (
      <section className="panel quick-add">
<div className="sechead quick-head">
          <h1 className="h">{t("quick.title")}</h1>
          <button type="button" className="btn" onClick={advanced} title={t("quick.advancedHelp")}>{t("quick.advanced")}</button>
        </div>
        <p className="lead">{t("quick.lead")}</p>
        <div className="seg" role="radiogroup" aria-label={t("host.where")}>
          {(["upload", "github"] as const).map((k) => (
            <label key={k} className={kind === k ? "on" : ""}>
              <input type="radio" name="quick-kind" checked={kind === k} onChange={() => setKind(k)} disabled={phase === "scanning"} />
              {t(`host.mode.${k}`)}
            </label>
          ))}
        </div>
        {phase === "scanning" ? (
          <p className="job-working quick-scan" role="status"><span className="dots-anim" aria-hidden="true"><i /><i /><i /></span>{t("quick.scanning")}</p>
        ) : kind === "upload" ? (
          <HostedUpload picked={picked} onPick={onPick} hosted={null} progress={null} />
        ) : (
          <>
            <GitHubFollow row={null} choice={git} onChoice={setGit} onChanged={() => {}} />
            <div className="actions">
              <button type="button" className="btn primary" disabled={!git?.branch} onClick={() => git && read(scanRepo(git.installation_id, git.repo, git.branch))}>{t("quick.readRepo")}</button>
            </div>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
      </section>
    );
  }

  if (phase === "review" && p && scan) {
    if (kind === "github" && scan.folder === null) {
      return (
        <section className="panel quick-add">
          <h1 className="h">{t("quick.title")}</h1>
          <p className="check warn">{scan.needsBuild ? t("quick.needsBuild") : t("quick.noGame")}</p>
          <div className="actions">
            {scan.needsBuild && <Link to="/my-games#upload-keys" className="btn primary">{t("quick.useAction")}</Link>}
            <button type="button" className="btn" onClick={() => setPhase("pick")}>{t("quick.back")}</button>
          </div>
        </section>
      );
    }
    const field = <K extends keyof Proposal>(k: K) => (v: Proposal[K]) => setP({ ...p, [k]: v });
    return (
      <section className="panel quick-add">
<div className="sechead quick-head">
          <h1 className="h">{t("quick.reviewTitle")}</h1>
          <button type="button" className="btn" onClick={advanced} title={t("quick.advancedHelp")}>{t("quick.advanced")}</button>
        </div>
        <p className="lead">{scan.ai ? t("quick.reviewLead") : t("quick.reviewLeadNoAi")}</p>
        <div className="form quick-form">
          <label htmlFor="q-title">{t("form.title")}</label>
          <input id="q-title" maxLength={60} value={p.title} onChange={(e) => field("title")(e.target.value)} />
          <label htmlFor="q-desc">{t("form.description")}</label>
          <textarea id="q-desc" rows={3} maxLength={1000} value={p.description} onChange={(e) => field("description")(e.target.value)} />
          <div className="pair">
            <div>
              <label htmlFor="q-cat">{t("form.category")}</label>
              <select id="q-cat" value={p.category} onChange={(e) => field("category")(e.target.value as Category)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="q-controls">{t("form.controls")}</label>
              <input id="q-controls" maxLength={500} value={p.controls} onChange={(e) => field("controls")(e.target.value)} />
            </div>
          </div>
          <details className="quick-more">
            <summary>{t("quick.more")}</summary>
            <label htmlFor="q-desc-de">{t("form.descriptionDe")}</label>
            <textarea id="q-desc-de" rows={3} maxLength={1000} value={p.description_de} onChange={(e) => field("description_de")(e.target.value)} />
            <label htmlFor="q-controls-de">{t("form.controlsDe")}</label>
            <input id="q-controls-de" maxLength={500} value={p.controls_de} onChange={(e) => field("controls_de")(e.target.value)} />
            <div className="pair">
              <div>
                <label htmlFor="q-engine">{t("form.engine")}</label>
                <input id="q-engine" maxLength={30} value={p.engine} onChange={(e) => field("engine")(e.target.value)} />
              </div>
              <div>
                <label htmlFor="q-order">{t("form.scores")}</label>
                <select id="q-order" value={`${p.score_order}:${p.score_format}`} onChange={(e) => { const [o, f] = e.target.value.split(":"); setP({ ...p, score_order: o as "high" | "low", score_format: f as "points" | "time" }); }}>
                  <option value="high:points">{t("form.scoreOrder.high")} · {t("form.scoreFormat.points")}</option>
                  <option value="low:points">{t("form.scoreOrder.low")} · {t("form.scoreFormat.points")}</option>
                  <option value="low:time">{t("form.scoreOrder.low")} · {t("form.scoreFormat.time")}</option>
                  <option value="high:time">{t("form.scoreOrder.high")} · {t("form.scoreFormat.time")}</option>
                </select>
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={p.isolation} onChange={(e) => field("isolation")(e.target.checked)} />
              {t("form.isolation")}
            </label>
            <label className="check">
              <input type="checkbox" checked={p.multiplayer === true} onChange={(e) => { field("multiplayer")(e.target.checked); setInvites(e.target.checked && !p.has_rooms && codeAi !== "off"); }} />
              {t("form.multiplayer")}
            </label>
            {kind === "github" && git && (
              <>
                <label htmlFor="q-folder">{t("git.folder")}</label>
                <input id="q-folder" maxLength={200} placeholder={t("git.folderPlaceholder")} value={git.folder} onChange={(e) => setGit({ ...git, folder: e.target.value })} />
              </>
            )}
          </details>

          <ul className="quick-features">
            {!p.saves_elsewhere ? (
              <li className="check good">{t("quick.saves")}</li>
            ) : codeAi === "off" ? (
              <li className="check warn">{t("quick.savesElsewhere")}</li>
            ) : (
              <li className="check">
                <label className="fb-check">
                  <input type="checkbox" checked={savesAi} onChange={(e) => setSavesAi(e.target.checked)} />
                  <span>{kind === "github" ? t("quick.savesGithub") : t("quick.savesUpload")}</span>
                </label>
              </li>
            )}
            {p.has_scores ? (
              <li className="check good">{t("quick.hasScores")}</li>
            ) : codeAi === "off" ? (
              <li className="check">{t("quick.noCodeAi")}</li>
            ) : (
              <li className="check">
                <label className="fb-check">
                  <input type="checkbox" checked={leaderboard} onChange={(e) => setLeaderboard(e.target.checked)} />
                  <span>{kind === "github" ? t("quick.leaderboardGithub") : t("quick.leaderboardUpload")}</span>
                </label>
              </li>
            )}
            {p.multiplayer && (p.has_rooms ? (
              <li className="check good">{t("quick.hasInvites")}</li>
            ) : codeAi === "off" ? (
              <li className="check">{t("quick.noCodeAiInvites")}</li>
            ) : (
              <li className="check">
                <label className="fb-check">
                  <input type="checkbox" checked={invites} onChange={(e) => setInvites(e.target.checked)} />
                  <span>{kind === "github" ? t("quick.invitesGithub") : t("quick.invitesUpload")}</span>
                </label>
              </li>
            ))}
          </ul>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="btn primary" onClick={publish} disabled={!p.title.trim()}>{t("quick.publish")}</button>
            <button type="button" className="btn" onClick={() => setPhase("pick")}>{t("quick.back")}</button>
          </div>
        </div>
      </section>
    );
  }

  // publishing / done
  const mark = (s: StepState) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "skip" ? "–" : s === "busy" ? "…" : "·");
  const question = job?.status === "question";
  const madeChange = job?.status === "done" && (job.pr_url || job.messages.some((m) => m.kind === "done" && m.files.length > 0));
  // What the AI adds: "Saves, leaderboard and friend invites", or some of them.
  const adding = listOf([
    ...(savesAi && p?.saves_elsewhere ? [t("quick.what.saves")] : []),
    ...(leaderboard ? [t("quick.what.scores")] : []),
    ...(invites && p?.multiplayer ? [t("quick.what.invites")] : []),
  ], lang);
  return (
    <section className="panel quick-add">
      <h1 className="h">{phase === "done" && steps.files === "ok" ? t("quick.liveTitle") : t("quick.publishing")}</h1>
      <ol className="quick-steps">
        <li className={steps.create}><b aria-hidden="true">{mark(steps.create)}</b> {t("quick.step.create")}</li>
        <li className={steps.files}>
          <b aria-hidden="true">{mark(steps.files)}</b> {kind === "github" ? t("quick.step.github") : steps.files === "busy" ? t("host.uploadingPct", { pct: Math.round(pct * 100) }) : t("quick.step.upload")}
        </li>
        {steps.leaderboard !== "skip" && (
          <li className={steps.leaderboard}>
            <b aria-hidden="true">{mark(steps.leaderboard)}</b>{" "}
            <b>{adding}:</b>{" "}
            {steps.leaderboard === "busy" && !question ? t("quick.step.leaderboardBusy")
              : question ? t("quick.step.question")
              : steps.leaderboard === "ok" ? (madeChange ? (job?.pr_url ? t("quick.step.leaderboardPr") : t("quick.step.leaderboardLive")) : t("quick.step.leaderboardAlready"))
              : steps.leaderboard === "fail" ? t("quick.step.leaderboardFailed")
              : t("quick.step.leaderboard")}
            {job && (question || steps.leaderboard !== "ok" || job.pr_url) && (
              <>
                {" "}
                {job.pr_url ? (
                  <a href={job.pr_url} target="_blank" rel="noopener noreferrer">{t("connect.openPr")} ↗</a>
                ) : (
                  <Link to={`/connect/${job.id}`}>{question ? t("quick.answer") : t("quick.details")}</Link>
                )}
              </>
            )}
          </li>
        )}
      </ol>
      {err && <p className="error" role="alert">{err}</p>}
      {building && <BuildInfo repo={building.repo} branch={building.branch} link={building.pr ?? building.manual} ready={building.ready} waiting={building.ready && !building.started} />}
      {phase === "done" && game && (
        <div className="actions">
          {steps.files === "ok" && <button type="button" className="btn primary" onClick={() => navigate(`/game/${game.slug}`)}>{t("quick.open")}</button>}
          <Link to={`/edit/${game.slug}`} className="btn">{t("quick.edit")}</Link>
        </div>
      )}
      {phase === "done" && steps.files === "ok" && <p className="sub">{t("quick.coverHint")}</p>}
    </section>
  );
}

