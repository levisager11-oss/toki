import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n, listOf } from "../lib/i18n";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { slugify } from "../lib/games";
import { invalidateGames } from "../lib/useGames";
import { coverFor } from "../pixel/scenes";
import { CATEGORIES, type Category } from "../lib/types";
import { JOIN_PARAM, siteFor, siteUrl } from "../lib/hostingRules";
import { removeGameImages } from "../lib/gameImages";
import { useAiFeature } from "../lib/assist";
import { GamePictures, type Pictures } from "./GamePictures";
import { ApiError, connectError, runJob, type ConnectJob } from "../lib/ai";
import {
  type BuildSetup,
  gitBuild, gitConnect, hostError, scanRepo, scanSample, scanUpload, startAdditions, uploadGame, uploadName, type GitChoice, type HostingStatus, type Proposal, type ScanResult,
} from "../lib/hosting";
import { HostedUpload, type Picked } from "./HostedUpload";
import { BuildAsk, BuildInfo, GitHubFollow, gitFailed } from "./GitHubFollow";

type Phase = "pick" | "scanning" | "review" | "publishing" | "done";
type Step = "create" | "files" | "leaderboard";
type StepState = "wait" | "busy" | "ok" | "skip" | "fail";

/**
 * "Let Toki's AI do it" on Add game: drop the game or pick a GitHub repository, Toki's AI reads it
 * and proposes its page, and one button puts it live. The page has everything the full form has
 * (pictures, address, rooms), and "What Toki found" says what the game has of Toki's features. The
 * AI changes the game's code (saves, a leaderboard, achievements, more lists, friend invites) only
 * for what the developer ticks; each missing one shows the line to add by hand.
 */

/** What Toki's AI can add to a game's code (Toki Connect, in one run). */
type AiFeature = "saves" | "scores" | "achievements" | "boards" | "multiplayer";
const AI_FEATURES: AiFeature[] = ["saves", "scores", "achievements", "boards", "multiplayer"];
/** The game has it already (a sure sign in its code). */
const hasIt = (f: AiFeature, p: Proposal) =>
  f === "saves" ? !p.saves_elsewhere : f === "scores" ? p.has_scores : f === "achievements" ? !!p.has_achievements : f === "boards" ? !!p.has_boards : !!p.has_rooms;
/** The ones that apply to this game: more lists only with a score, invites only with rooms. */
const applies = (f: AiFeature, p: Proposal) => (f === "boards" ? p.leaderboard || p.has_scores : f === "multiplayer" ? p.multiplayer : true);
/** The line to add by hand, and its part of the developer docs. */
const BY_HAND: Record<AiFeature, { code: string; anchor: string }> = {
  saves: { code: 'localStorage.setItem("save", data)', anchor: "saves" },
  scores: { code: "toki.score(points)", anchor: "scores" },
  achievements: { code: 'toki.achievement("id")', anchor: "achievements" },
  boards: { code: 'toki.score(points, "id")', anchor: "scores" },
  multiplayer: { code: "toki.room(code)", anchor: "rooms" },
};
/** What the one-click screen hands to the full form ("Fill it in myself"), so nothing is lost. */
export interface QuickCarry {
  proposal: Proposal | null;
  picked: Picked | null;
  git: GitChoice | null;
  /** "link": the game is online elsewhere already, the full form opens with its address field */
  kind: "upload" | "github" | "link";
  /** The rest of the page, as far as it was filled in here */
  pictures?: Pictures;
  /** pictures uploaded here: the full form deletes the ones that aren't saved */
  uploaded?: string[];
  slug?: string;
  maxPlayers?: string;
  joinParam?: string;
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
  // What the developer ticked for the AI to add to the game's code (nothing at first).
  const [ai, setAi] = useState<Set<AiFeature>>(new Set());
  // The page's address: made from the title until the developer types one.
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState("");
  const [joinParam, setJoinParam] = useState("room");
  const [pics, setPics] = useState<Pictures>({ cover: "", image: null, banner: null, shots: [] });
  const [picBusy, setPicBusy] = useState(false);
  // Pictures uploaded on this page: the ones that don't end up with the game are deleted again.
  const uploaded = useRef<string[]>([]);
  const keepPics = useRef(false);
  useEffect(() => () => {
    if (!keepPics.current) removeGameImages(uploaded.current);
  }, []);
  const [err, setErr] = useState("");
  // The repository holds the source: GitHub Actions builds it, after its build file is merged.
  const [building, setBuilding] = useState<(BuildSetup & { repo: string; branch: string }) | null>(null);
  // Connected, and its repository holds the source: "Build it with GitHub Actions?"
  const [ask, setAsk] = useState<{ repo: string; branch: string } | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const buildIt = async () => {
    if (!game || !ask) return;
    setAskBusy(true);
    setErr("");
    try {
      const r = await gitBuild(game.id);
      if (!r.ok) setErr(gitFailed(t, r.error, r.engine));
      else {
        if (r.building) setBuilding({ ...r.building, ...ask });
        setAsk(null);
      }
    } catch (e) {
      setErr(t(`host.err.${hostError(e)}`, { mb: "100 MB" }));
    }
    setAskBusy(false);
  };
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
  const helper = useAiFeature("learn");

  // ---------- 1. read the game ----------

  const read = async (result: Promise<ScanResult>) => {
    setErr("");
    setPhase("scanning");
    try {
      const r = await result;
      if (!alive.current) return;
      setScan(r);
      setP(r.proposal);
      // The AI changes the game's code only when the developer ticks it.
      setAi(new Set());
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
    read(scanSample(x.files, x.entry).then((sample) => scanUpload(uploadName(x), x.files, sample)));
  };

  // ---------- 2. publish ----------

  const set = (s: Step, v: StepState) => setSteps((all) => ({ ...all, [s]: v }));
  const effSlug = slugEdited ? slug : slugify(p?.title ?? "");
  /** Ticked, and still something the game is missing. */
  const chosen = p ? AI_FEATURES.filter((f) => ai.has(f) && applies(f, p) && !hasIt(f, p)) : [];

  const publish = async () => {
    if (!p || !profile || !hosting.domain) return;
    setErr("");
    setPhase("publishing");
    // The game's page first: the address the developer typed, else a free one ("snake", "snake-2", …).
    set("create", "busy");
    const base = slugify(p.title) || "game";
    const players = Math.round(Number(maxPlayers));
    let row: { id: string; slug: string } | null = null;
    let taken = false;
    for (let n = 1; n <= (slugEdited ? 1 : 9) && !row; n++) {
      const slug = slugEdited ? effSlug : n === 1 ? base : `${base.slice(0, 37)}-${n}`;
      const { data, error } = await supabase
        .from("games")
        .insert({
          slug, title: p.title, description: p.description, description_de: p.description_de || null, controls: p.controls, controls_de: p.controls_de || null, category: p.category,
          engine: p.engine || null, cover: pics.cover || coverFor(slug, null), thumbnail_url: pics.image, banner_url: pics.banner, screenshots: pics.shots,
          play_url: siteUrl(siteFor(slug), hosting.domain), needs_isolation: p.isolation,
          score_order: p.score_order, score_format: p.score_format, multiplayer: p.multiplayer,
          max_players: p.multiplayer && players >= 2 && players <= 64 ? players : null,
          join_param: JOIN_PARAM.test(joinParam.trim()) ? joinParam.trim() : "room",
          created_by: profile.id,
        })
        .select("id, slug")
        .single();
      if (data) row = data as { id: string; slug: string };
      else if (error?.code === "23505") taken = true;
      else break;
    }
    if (!row) {
      set("create", "fail");
      setErr(t(slugEdited && taken ? "form.slugTaken" : "form.error"));
      return setPhase("review");
    }
    set("create", "ok");
    setGame(row);
    // The pictures stay with the game; the ones taken away again are deleted.
    keepPics.current = true;
    const used = new Set([pics.image, pics.banner, ...pics.shots]);
    removeGameImages(uploaded.current.filter((u) => !used.has(u)));
    invalidateGames();

    // The files: uploaded, or the branch's newest version from GitHub.
    set("files", "busy");
    // Source code only: nothing goes live until GitHub Actions has built it.
    let waitsForBuild = false;
    try {
      if (kind === "upload" && picked) await uploadGame(row.id, picked.files, p.isolation, (d, total) => setPct(d / total));
      else if (git) {
        const r = await gitConnect(row.id, git);
        // The repository holds the source: the developer is asked whether GitHub Actions should build it.
        if (!r.ok && r.error === "needs_build") {
          setAsk({ repo: git.repo, branch: git.branch });
          waitsForBuild = true;
        } else if (!r.ok) throw new Error(r.error === "cant_build" ? gitFailed(t, r.error, r.engine) : r.error ?? "error");
        if (r.building) setBuilding({ ...r.building, repo: git.repo, branch: git.branch });
      }
      set("files", waitsForBuild ? "skip" : "ok");
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

    // What the developer ticked: Toki Connect changes the code in one run (a new live version, or
    // one pull request).
    const features = chosen;
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
  const advanced = () => {
    keepPics.current = true;
    onManual({ proposal: p, picked, git, kind, pictures: pics, uploaded: uploaded.current, slug: slugEdited ? slug : undefined, maxPlayers, joinParam });
  };
  const byLink = () => onManual({ proposal: null, picked: null, git: null, kind: "link" });

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
        {phase === "pick" && (
          <p className="quick-link">
            {t("quick.byLinkLead")} <button type="button" className="linkish" onClick={byLink}>{t("quick.byLink")}</button>
          </p>
        )}
      </section>
    );
  }

  if (phase === "review" && p && scan) {
    // Source code only: carried on below (the game is added, then GitHub Actions is offered to build it).
    if (kind === "github" && scan.folder === null && !scan.needsBuild) {
      return (
        <section className="panel quick-add">
          <h1 className="h">{t("quick.title")}</h1>
          <p className="check warn">{t("quick.noGame")}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setPhase("pick")}>{t("quick.back")}</button>
          </div>
        </section>
      );
    }
    const field = <K extends keyof Proposal>(k: K) => (v: Proposal[K]) => setP({ ...p, [k]: v });
    const shown = AI_FEATURES.filter((f) => applies(f, p));
    const missing = shown.filter((f) => !hasIt(f, p));
    const tick = (f: AiFeature, on: boolean) => setAi((all) => {
      const next = new Set(all);
      if (on) next.add(f);
      else next.delete(f);
      return next;
    });
    return (
      <section className="panel quick-add">
        <div className="sechead quick-head">
          <h1 className="h">{t("quick.reviewTitle")}</h1>
          <button type="button" className="btn" onClick={advanced} title={t("quick.advancedHelp")}>{t("quick.advanced")}</button>
        </div>
        <p className="lead">{scan.ai ? t("quick.reviewLead") : t("quick.reviewLeadNoAi")}</p>
        {kind === "github" && scan.needsBuild && <p className="check">{t("quick.willBuild")}</p>}
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
            <label htmlFor="q-slug">{t("form.slug")}</label>
            <div className="prefix">
              <span>/game/</span>
              <input id="q-slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} value={effSlug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }} />
            </div>
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
              <input type="checkbox" checked={p.multiplayer === true} onChange={(e) => { field("multiplayer")(e.target.checked); if (!e.target.checked) tick("multiplayer", false); }} />
              {t("form.multiplayer")}
            </label>
            {p.multiplayer && (
              <div className="pair">
                <div>
                  <label htmlFor="q-max">{t("form.maxPlayers")}</label>
                  <input id="q-max" type="number" inputMode="numeric" min={2} max={64} placeholder="4" value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="q-join">{t("form.joinParam")}</label>
                  <input id="q-join" maxLength={20} pattern="[a-z][a-z0-9_\-]{0,19}" placeholder="room" autoCapitalize="none" spellCheck={false} value={joinParam} onChange={(e) => setJoinParam(e.target.value.toLowerCase())} />
                </div>
              </div>
            )}
            {kind === "github" && git && (
              <>
                <label htmlFor="q-folder">{t("git.folder")}</label>
                <input id="q-folder" maxLength={200} placeholder={t("git.folderPlaceholder")} value={git.folder} onChange={(e) => setGit({ ...git, folder: e.target.value })} />
              </>
            )}
          </details>
          <details className="quick-more">
            <summary>{t("quick.pictures")}</summary>
            <div className="col quick-pics">
              <GamePictures slug={effSlug} value={{ ...pics, cover: pics.cover || coverFor(effSlug || "game", null) }} onChange={setPics} uploaded={uploaded} onError={setErr} onBusy={setPicBusy} />
            </div>
          </details>

          <h2 className="quick-sub">{t("quick.found")}</h2>
          <ul className="quick-features">
            {shown.map((f) => (
              <li key={f} className={`check ${hasIt(f, p) ? "good" : ""}`}>
                <b aria-hidden="true">{hasIt(f, p) ? "✓" : "–"}</b> {t(`quick.found.${f}.${hasIt(f, p) ? "yes" : "no"}`)}
                {!hasIt(f, p) && <Yourself code={BY_HAND[f].code} anchor={BY_HAND[f].anchor} />}
              </li>
            ))}
          </ul>

          {missing.length > 0 && codeAi !== "off" && (
            <>
              <h2 className="quick-sub">{t("quick.aiAdd")}</h2>
              <p className="sub">{kind === "github" ? t("quick.aiAddGithub") : t("quick.aiAddUpload")}</p>
              <ul className="quick-features">
                {missing.map((f) => (
                  <li key={f} className="check">
                    <label className="fb-check">
                      <input type="checkbox" checked={ai.has(f)} onChange={(e) => tick(f, e.target.checked)} />
                      <span>{t(`quick.ai.${f}`)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="btn primary" onClick={publish} disabled={!p.title.trim() || picBusy}>{t("quick.publish")}</button>
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
  const adding = listOf(chosen.map((f) => t(`quick.what.${f}`)), lang);
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
      {ask && game && <BuildAsk busy={askBusy} onYes={buildIt} onLater={() => setAsk(null)} />}
      {building && game && <BuildInfo gameId={game.id} repo={building.repo} branch={building.branch} setup={building} />}
      {phase === "done" && game && (
        <div className="actions">
          {steps.files === "ok" && <button type="button" className="btn primary" onClick={() => navigate(`/game/${game.slug}`)}>{t("quick.open")}</button>}
          <Link to={`/edit/${game.slug}`} className="btn">{t("quick.edit")}</Link>
        </div>
      )}
      {phase === "done" && game && steps.files === "ok" && (
        <div className="quick-next">
          <h2 className="quick-sub">{t("quick.next")}</h2>
          <ul>
            <li><Link to={`/edit/${game.slug}#achievements`}>{t("ach.setup.title")}</Link> · {t("quick.next.achievements")}</li>
            <li><Link to={`/edit/${game.slug}#boards`}>{t("boards.setup.title")}</Link> · {t("quick.next.boards")}</li>
            <li><Link to={`/edit/${game.slug}#cosmetics`}>{t("gcos.title")}</Link> · {t("quick.next.cosmetics")}</li>
            {helper && <li><Link to={`/edit/${game.slug}#helper`}>{t("helper.setup.title")}</Link> · {t("quick.next.helper")}</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

/** "Or add it yourself": the line of code, and where the developer docs explain it. */
function Yourself({ code, anchor }: { code: string; anchor: string }) {
  const { t } = useI18n();
  return (
    <small className="quick-diy">
      {t("quick.diy")} <code>{code}</code> · <Link to={`/docs#${anchor}`} target="_blank" rel="noopener">{t("quick.diyDocs")}</Link>
    </small>
  );
}
