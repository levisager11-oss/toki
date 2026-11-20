import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { getGame, slugify } from "../lib/games";
import { invalidateGames } from "../lib/useGames";
import { CATEGORIES, type Category, type Game } from "../lib/types";
import { coverFor } from "../pixel/scenes";
import { GamePictures, MAX_SHOTS } from "../components/GamePictures";
import { NotFound } from "./NotFound";
import { LinkCheck } from "../components/LinkCheck";
import { MultiplayerSetup, SaveSupport } from "../components/SaveSupport";
import { AiBox } from "../components/AiBits";
import { HelperSetup } from "../components/HelperSetup";
import { AchievementsSetup } from "../components/AchievementsSetup";
import { BoardsSetup } from "../components/BoardsSetup";
import { CosmeticsSetup } from "../components/CosmeticsSetup";
import { assistError, describeGame, useAiFeature } from "../lib/assist";
import { useTitle } from "../lib/useTitle";
import { removeGameImages } from "../lib/gameImages";
import { HostedUpload, type Picked } from "../components/HostedUpload";
import { ImportFromLink } from "../components/ImportFromLink";
import { gitConnect, gitDisconnect, hostError, scanSample, scanUpload, unhostGame, uploadGame, uploadName, useHosting, type GitChoice, type GitRow, type Imported } from "../lib/hosting";
import { GitHubFollow, gitFailed } from "../components/GitHubFollow";
import { QuickAdd, type QuickCarry } from "../components/QuickAdd";
import { AddStart, type AddStartChoice } from "../components/AddStart";
import { MovedNotice, MoveSavesCheck, MoveToToki, type Moved } from "../components/MoveToToki";

// The way in a developer picked on Add game's first screen opens straight away next time (this
// browser only); "Other ways to add" shows the choice again. (toki.addAdvanced: the older "Advanced".)
const START_KEY = "toki.addStart";
const OLD_ADVANCED_KEY = "toki.addAdvanced";
const rememberedStart = (): AddStartChoice | null => {
  try {
    const v = localStorage.getItem(START_KEY);
    if (v === "manual" || v === "ai" || v === "link") return v;
    return localStorage.getItem(OLD_ADVANCED_KEY) === "1" ? "manual" : null;
  } catch {
    return null;
  }
};
const rememberStart = (c: AddStartChoice | null) => {
  try {
    localStorage.removeItem(OLD_ADVANCED_KEY);
    if (c) localStorage.setItem(START_KEY, c);
    else localStorage.removeItem(START_KEY);
  } catch {
    /* only a convenience */
  }
};
import { isOnToki, JOIN_PARAM, siteFor, siteUrl } from "../lib/hostingRules";


export function GameForm() {
  const { slug: editSlug } = useParams();
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const hosting = useHosting();
  const [orig, setOrig] = useState<Game | null>(null);
  useTitle(editSlug ? t("form.editTitle") : t("form.addTitle"));
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionDe, setDescriptionDe] = useState("");
  const [controls, setControls] = useState("");
  const [controlsDe, setControlsDe] = useState("");
  const [category, setCategory] = useState<Category>("action");
  const [engine, setEngine] = useState("");
  const [cover, setCover] = useState<string>("");
  const [image, setImage] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [featured, setFeatured] = useState(false);
  const [isolation, setIsolation] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  const [scoreOrder, setScoreOrder] = useState<"high" | "low">("high");
  const [scoreFormat, setScoreFormat] = useState<"points" | "time">("points");
  // Play together: the game has rooms friends can be invited into (src/lib/invites.ts).
  const [multiplayer, setMultiplayer] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState("");
  const [joinParam, setJoinParam] = useState("room");
  const [err, setErr] = useState<string>((location.state as { uploadError?: string } | null)?.uploadError ?? "");
  // Where the game runs: uploaded to Toki, from a GitHub branch, or a link to elsewhere (null: not picked yet).
  const [start, setStart] = useState<AddStartChoice | null>(rememberedStart);
  const [mode, setMode] = useState<"upload" | "github" | "link" | null>(() => (start === "link" ? "link" : null));
  const [git, setGit] = useState<GitRow | null>(null);
  const [gitChoice, setGitChoice] = useState<GitChoice | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Just moved from its link onto Toki (MoveToToki): shown with the way back.
  const [moved, setMoved] = useState<Moved | null>(null);
  // A linked game switched to an upload or a repository: players' progress can come along, or the developer accepted it can't.
  const [savesReady, setSavesReady] = useState(false);
  // Pictures uploaded while this form is open. The ones not saved with the game are deleted again.
  const uploaded = useRef<string[]>([]);
  const saved = useRef(false);
  useEffect(
    () => () => {
      if (!saved.current) removeGameImages(uploaded.current);
    },
    [],
  );
  // Something was typed or picked: closing or reloading the tab asks first.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const loadGit = (gameId: string) =>
    supabase.from("game_git").select("*").eq("game_id", gameId).maybeSingle().then(({ data }) => setGit((data as GitRow | null) ?? null));
  useEffect(() => {
    if (orig) loadGit(orig.id);
  }, [orig]);

  useEffect(() => {
    if (!editSlug) return;
    getGame(editSlug).then((g) => {
      if (!g) return setMissing(true);
      setOrig(g);
      setTitle(g.title);
      setSlug(g.slug);
      setSlugEdited(true);
      setUrl(g.play_url);
      setDescription(g.description);
      setDescriptionDe(g.description_de ?? "");
      setControls(g.controls);
      setControlsDe(g.controls_de ?? "");
      setCategory(g.category);
      setEngine(g.engine ?? "");
      setCover(coverFor(g.slug, g.cover));
      setImage(g.thumbnail_url);
      setBanner(g.banner_url ?? null);
      setFeatured(g.featured);
      setIsolation(g.needs_isolation === true);
      setShots(g.screenshots ?? []);
      setScoreOrder(g.score_order ?? "high");
      setScoreFormat(g.score_format ?? "points");
      setMultiplayer(g.multiplayer === true);
      setMaxPlayers(g.max_players ? String(g.max_players) : "");
      setJoinParam(g.join_param || "room");
    }, () => setLoadFailed(true));
  }, [editSlug]);

  // Opened as /edit/<game>#achievements (from "Set up next" after adding a game): that part,
  // once it has loaded.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!orig || !/^(achievements|boards|cosmetics|helper)$/.test(id)) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 20) clearInterval(timer);
      el?.scrollIntoView({ block: "start" });
    }, 150);
    return () => clearInterval(timer);
  }, [orig, location.hash]);

  /** After moving to Toki or back: the game's address changed on the server. */
  const reloadWhere = async (slugNow: string) => {
    invalidateGames();
    const g = await getGame(slugNow);
    if (!g) return;
    setOrig(g);
    setUrl(g.play_url);
    setIsolation(g.needs_isolation === true);
    setMode(null);
  };

  /** Picked on the first screen: the full form (by itself, or with its address field), or the AI's way. */
  const pick = (c: AddStartChoice) => {
    rememberStart(c);
    setStart(c);
    setMode(c === "link" ? "link" : null);
  };
  /** "Fill it in myself" on the AI's screen: the full form, filled in with what it had so far. */
  const toAdvanced = (c: QuickCarry) => {
    rememberStart(c.kind === "link" ? "link" : "manual");
    setStart(c.kind === "link" ? "link" : "manual");
    const p = c.proposal;
    if (p) {
      setTitle(p.title);
      setSlug(slugify(p.title));
      setDescription(p.description);
      setDescriptionDe(p.description_de);
      setControls(p.controls);
      setControlsDe(p.controls_de);
      setCategory(p.category);
      setEngine(p.engine);
      setScoreOrder(p.score_order);
      setScoreFormat(p.score_format);
      setMultiplayer(p.multiplayer === true);
      setIsolation(p.isolation);
      setDirty(true);
    }
    // Pictures uploaded on the AI's screen are this form's now: unsaved ones are deleted with its own.
    if (c.uploaded) uploaded.current.push(...c.uploaded);
    if (c.pictures) {
      setCover(c.pictures.cover);
      setImage(c.pictures.image);
      setBanner(c.pictures.banner);
      setShots(c.pictures.shots);
    }
    if (c.slug) {
      setSlug(c.slug);
      setSlugEdited(true);
    }
    if (c.maxPlayers) setMaxPlayers(c.maxPlayers);
    if (c.joinParam) setJoinParam(c.joinParam);
    if (c.kind === "link") setMode("link");
    else if (c.kind === "github") {
      setMode("github");
      if (c.git) setGitChoice(c.git);
    } else {
      setMode("upload");
      if (c.picked) setPicked(c.picked);
    }
  };
  /** "Other ways to add": the first screen again. */
  const toStart = () => {
    rememberStart(null);
    setStart(null);
  };

  if (missing) return <NotFound />;
  if (loadFailed) return <p className="msg">{t("error")}</p>;
  // A new game: the three ways in first. Without uploads to Toki, only a link is possible: the form.
  if (!editSlug && start !== "manual" && start !== "link") {
    if (hosting === null) return <p className="msg" aria-busy="true">{t("loading")}</p>;
    if (hosting.enabled && hosting.domain) return start === "ai" ? <QuickAdd hosting={hosting} onManual={toAdvanced} /> : <AddStart onPick={pick} />;
  }
  // Editing waits for the hosting settings too: whether the game is on Toki depends on Toki's games domain.
  if (editSlug && (!orig || hosting === null)) return <p className="msg">{t("loading")}</p>;
  if (orig && profile && profile.role !== "admin" && orig.created_by !== profile.id) return <p className="msg">{t("auth.noRights")}</p>;

  const effectiveSlug = slugEdited ? slug : slugify(title);
  // Hosted on Toki right now: its link is its own address there.
  // (Its own name alone isn't enough: debtdrifter.vercel.app starts like debtdrifter.playtoki.app.)
  const wasHosted = isOnToki(orig, hosting?.domain);
  const canHost = !!hosting?.enabled && !!hosting.domain;
  const effMode = mode ?? (orig ? (git ? "github" : wasHosted ? "upload" : "link") : canHost ? "upload" : "link");
  const hosted = effMode !== "link" && (canHost || wasHosted);
  const fromGit = hosted && effMode === "github";
  const previewCover = cover || coverFor(effectiveSlug || "game", null);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    let playUrl = url.trim();
    if (hosted) {
      if (fromGit ? !git && !gitChoice?.branch : !picked && !wasHosted) return setErr(t(fromGit ? "git.pickFirst" : "host.err.pickFirst"));
      if (!wasHosted && !hosting?.domain) return setErr(t("host.err.hosting_off"));
      if (orig && !wasHosted && !savesReady) return setErr(t("move.checkFirst"));
      // Until the upload is done the game keeps its address (a link elsewhere stays, so Toki can
      // carry players' progress over from there); the server then sets the new one.
      playUrl = orig ? orig.play_url : siteUrl(siteFor(effectiveSlug), hosting!.domain!);
    } else if (!/^https:\/\//i.test(playUrl)) return setErr(t("form.badUrl"));
    const players = Math.round(Number(maxPlayers));
    const row = {
      slug: effectiveSlug,
      title: title.trim(),
      play_url: playUrl,
      description: description.trim(),
      description_de: descriptionDe.trim() || null,
      controls: controls.trim(),
      controls_de: controlsDe.trim() || null,
      category,
      engine: engine.trim() || null,
      cover: previewCover,
      thumbnail_url: image,
      banner_url: banner,
      screenshots: shots,
      featured, // the database un-features the previous game
      needs_isolation: isolation,
      score_order: scoreOrder,
      score_format: scoreFormat,
      multiplayer,
      max_players: players >= 2 && players <= 64 ? players : null,
      join_param: JOIN_PARAM.test(joinParam.trim()) ? joinParam.trim() : "room",
    };
    setBusy(true);
    const res = orig
      ? await supabase.from("games").update(row).eq("id", orig.id).select("id").single()
      : await supabase.from("games").insert({ ...row, created_by: profile!.id }).select("id").single();
    if (res.error) {
      setBusy(false);
      return setErr(res.error.code === "23505" ? t("form.slugTaken") : t("form.error"));
    }
    setDirty(false);
    // Pictures the game had or got here but doesn't use any more: delete them.
    saved.current = true;
    const used = new Set([row.thumbnail_url, row.banner_url, ...row.screenshots]);
    const before = orig ? [orig.thumbnail_url, orig.banner_url, ...(orig.screenshots ?? [])] : [];
    removeGameImages([...before, ...uploaded.current].filter((u) => u && !used.has(u)));
    if (fromGit && gitChoice?.branch && (!git || git.repo !== gitChoice.repo || git.branch !== gitChoice.branch || git.folder !== gitChoice.folder)) {
      // Connect, and put the branch's newest version live right away.
      setProgress(0.5);
      let msg = "";
      try {
        const r = await gitConnect(res.data.id, gitChoice);
        if (!r.ok) msg = gitFailed(t, r.error, r.engine);
      } catch (e) {
        msg = t(`host.err.${hostError(e)}`, { mb: "100 MB" });
      }
      setProgress(null);
      if (msg) {
        setBusy(false);
        invalidateGames();
        if (!orig) return navigate(`/edit/${row.slug}`, { replace: true, state: { uploadError: msg } });
        loadGit(orig.id);
        return setErr(msg);
      }
    }
    // Uploading by hand from now on: the game stops following GitHub.
    if (hosted && !fromGit && git && orig) await gitDisconnect(orig.id).catch(() => {});
    if (hosted && !fromGit && picked) {
      setProgress(0);
      try {
        await uploadGame(res.data.id, picked.files, isolation, (done, total) => setProgress(done / total));
      } catch (e) {
        setProgress(null);
        setBusy(false);
        invalidateGames();
        const msg = t(`host.err.${hostError(e)}`, { mb: "100 MB" });
        // A new game exists now: carry on on its edit page.
        if (!orig) return navigate(`/edit/${row.slug}`, { replace: true, state: { uploadError: msg } });
        return setErr(msg);
      }
    }
    // Moved from Toki to a link elsewhere: the uploaded versions are deleted.
    if (!hosted && wasHosted && orig) await unhostGame(orig.id).catch(() => {});
    setBusy(false);
    invalidateGames();
    navigate(`/game/${row.slug}`);
  };

  /**
   * A new game's files were picked: fill in the fields that are still empty from what simple checks
   * and the game's toki.json say. No AI reads the files here.
   */
  const fillFromFiles = async (p: Picked) => {
    if (orig) return;
    try {
      const { proposal: q } = await scanUpload(uploadName(p), p.files, await scanSample(p.files, p.entry), true);
      setTitle((v) => v.trim() ? v : q.title);
      setDescription((v) => v.trim() ? v : q.description);
      setDescriptionDe((v) => v.trim() ? v : q.description_de);
      setControls((v) => v.trim() ? v : q.controls);
      setControlsDe((v) => v.trim() ? v : q.controls_de);
      setEngine((v) => v.trim() ? v : q.engine);
      if (q.category !== "other") setCategory(q.category);
      if (q.isolation) setIsolation(true);
      if (q.multiplayer) setMultiplayer(true);
      setScoreOrder(q.score_order);
      setScoreFormat(q.score_format);
    } catch {
      /* only a help: the developer fills in the form */
    }
  };

  /** "Fill in from a link": fills the fields that are still empty from the game's page (no AI). */
  const applyImport = (d: Imported) => {
    setDirty(true);
    if (d.title && !title.trim()) onTitle(d.title);
    if (d.description && !description.trim()) setDescription(d.description);
    if (d.toki?.description_de && !descriptionDe.trim()) setDescriptionDe(d.toki.description_de);
    if (d.controls && !controls.trim()) setControls(d.controls);
    if (d.toki?.controls_de && !controlsDe.trim()) setControlsDe(d.toki.controls_de);
    if (d.category && !orig) setCategory(d.category);
    if (d.engine && !engine.trim()) setEngine(d.engine);
    if (d.isolation !== null) setIsolation(d.isolation);
    if (d.thumbnail_url && !image) setImage(d.thumbnail_url);
    if (d.screenshots.length && !shots.length) setShots(d.screenshots.slice(0, MAX_SHOTS));
    if (d.toki?.score_order) setScoreOrder(d.toki.score_order);
    if (d.toki?.score_format) setScoreFormat(d.toki.score_format);
    if (d.toki?.multiplayer !== undefined) setMultiplayer(d.toki.multiplayer);
    if (d.toki?.max_players) setMaxPlayers(String(d.toki.max_players));
    if (d.toki?.join_param) setJoinParam(d.toki.join_param);
    if (d.play_url && !wasHosted) {
      setUrl(d.play_url);
      setMode("link");
    }
    // Descriptions by AI only when asked for ("Write with AI").
  };

  const remove = async () => {
    if (!orig) return;
    setBusy(true);
    const { error } = await supabase.from("games").delete().eq("id", orig.id);
    setBusy(false);
    if (error) return setErr(t("form.error"));
    saved.current = true;
    removeGameImages([orig.thumbnail_url, orig.banner_url, ...(orig.screenshots ?? []), ...uploaded.current]);
    invalidateGames();
    navigate("/my-games");
  };

  return (
    <section className="panel">
      <div className="sechead quick-head">
        <h1 className="h">{orig ? t("form.editTitle") : t("form.addTitle")}</h1>
        {!orig && canHost && <button type="button" className="btn" onClick={toStart}>{t("start.other")}</button>}
      </div>
      <form className="form two" onSubmit={submit} onChange={() => setDirty(true)}>
        <div className="col">
          <ImportFromLink onImport={applyImport} />
          <label htmlFor="title">{t("form.title")}</label>
          <input id="title" required maxLength={60} value={title} onChange={(e) => onTitle(e.target.value)} />

          {(canHost || wasHosted) && (
            <>
              <span className="label-text" id="where-label">{t("host.where")}</span>
              <div className="seg" role="radiogroup" aria-labelledby="where-label">
                {(["upload", "github", "link"] as const).map((m) => (
                  <label key={m} className={effMode === m ? "on" : ""}>
                    <input type="radio" name="where" value={m} checked={effMode === m} onChange={() => setMode(m)} />
                    {t(`host.mode.${m}`)}
                  </label>
                ))}
              </div>
            </>
          )}
          {hosted ? (
            <>
              {moved && orig && <MovedNotice gameId={orig.id} moved={moved} onUndone={() => { setMoved(null); reloadWhere(orig.slug); }} />}
              {orig && !wasHosted && <MoveSavesCheck gameId={orig.id} mode={fromGit ? "github" : "upload"} onReady={setSavesReady} />}
              {fromGit ? (
                <GitHubFollow gameId={orig?.id} row={git} choice={gitChoice} onChoice={(c) => { setGitChoice(c); setDirty(true); }} onChanged={() => orig && loadGit(orig.id)} />
              ) : (
                <HostedUpload picked={picked} onPick={(p) => { setPicked(p); setDirty(true); if (p) fillFromFiles(p); }} gameId={orig?.id} hosted={wasHosted ? orig!.play_url : null} progress={progress} />
              )}
              {fromGit && git && wasHosted && <p className="sub"><a href={orig!.play_url} target="_blank" rel="noreferrer">{orig!.play_url.replace(/^https:\/\//, "")}</a></p>}
            </>
          ) : (
            <>
              <label htmlFor="url">{t("form.url")}</label>
              <input id="url" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby="url-help" />
              <small id="url-help">{t("form.urlHelp")}</small>
              {wasHosted && <p className="check warn">{t("host.leaveWarn")}</p>}
              <LinkCheck url={url.trim()} isolation={isolation} />
              {orig && !wasHosted && canHost && url.trim() === orig.play_url && (
                <MoveToToki gameId={orig.id} slug={orig.slug} url={orig.play_url} onMoved={(m) => { setMoved(m); reloadWhere(orig.slug); }} />
              )}
            </>
          )}
          <label className="check">
            <input id="isolation" type="checkbox" checked={isolation} onChange={(e) => setIsolation(e.target.checked)} aria-describedby="isolation-help" />
            {t("form.isolation")}
          </label>
          <small id="isolation-help">{hosted ? t("host.isolationHelp") : t("form.isolationHelp")}</small>
          {hosted ? <p className="check">{t("host.savesAuto")}</p> : <SaveSupport open={!orig} gameId={orig?.id} />}

          <label htmlFor="slug">{t("form.slug")}</label>
          <div className="prefix">
            <span>/game/</span>
            <input id="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} value={effectiveSlug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }} />
          </div>

          <div className="pair">
            <div>
              <label htmlFor="category">{t("form.category")}</label>
              <select id="category" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="engine">{t("form.engine")}</label>
              <input id="engine" maxLength={30} placeholder="Godot, Unity, Phaser…" value={engine} onChange={(e) => setEngine(e.target.value)} />
            </div>
          </div>

          <div className="pair">
            <div>
              <label htmlFor="score-order">{t("form.scores")}</label>
              <select id="score-order" value={scoreOrder} onChange={(e) => setScoreOrder(e.target.value as "high" | "low")} aria-describedby="scores-help">
                <option value="high">{t("form.scoreOrder.high")}</option>
                <option value="low">{t("form.scoreOrder.low")}</option>
              </select>
            </div>
            <div>
              <label htmlFor="score-format" className="sr-only">{t("form.scores")}</label>
              <select id="score-format" value={scoreFormat} onChange={(e) => setScoreFormat(e.target.value as "points" | "time")} style={{ marginTop: "auto" }}>
                <option value="points">{t("form.scoreFormat.points")}</option>
                <option value="time">{t("form.scoreFormat.time")}</option>
              </select>
            </div>
          </div>
          <small id="scores-help">{t("form.scoresHelp")}</small>

          <label className="check">
            <input id="multiplayer" type="checkbox" checked={multiplayer} onChange={(e) => setMultiplayer(e.target.checked)} aria-describedby="multiplayer-help" />
            {t("form.multiplayer")}
          </label>
          <small id="multiplayer-help">{t("form.multiplayerHelp")}</small>
          {multiplayer && (
            <>
              <div className="pair">
                <div>
                  <label htmlFor="max-players">{t("form.maxPlayers")}</label>
                  <input id="max-players" type="number" inputMode="numeric" min={2} max={64} placeholder="4" value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="join-param">{t("form.joinParam")}</label>
                  <input id="join-param" maxLength={20} pattern="[a-z][a-z0-9_\-]{0,19}" placeholder="room" autoCapitalize="none" spellCheck={false} value={joinParam} onChange={(e) => setJoinParam(e.target.value.toLowerCase())} aria-describedby="join-param-help" />
                </div>
              </div>
              <small id="join-param-help">{t("form.joinParamHelp", { example: `?\u2060${JOIN_PARAM.test(joinParam.trim()) ? joinParam.trim() : "room"}=ABCD` })}</small>
              <MultiplayerSetup gameId={orig?.id} />
            </>
          )}

          <label htmlFor="description">{t("form.description")}</label>
          <textarea id="description" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
          <label htmlFor="description-de">{t("form.descriptionDe")}</label>
          <textarea id="description-de" rows={3} maxLength={1000} value={descriptionDe} onChange={(e) => setDescriptionDe(e.target.value)} />
          <DescribeWithAi
            game={{ title: title.trim(), category, engine: engine.trim(), controls: controls.trim(), description: description.trim(), description_de: descriptionDe.trim(), play_url: url.trim() }}
            onUse={(d) => { setDescription(d.en); setDescriptionDe(d.de); }}
          />
          <label htmlFor="controls">{t("form.controls")}</label>
          <input id="controls" maxLength={500} placeholder={t("form.controlsHelp")} value={controls} onChange={(e) => setControls(e.target.value)} />
          <label htmlFor="controls-de">{t("form.controlsDe")}</label>
          <input id="controls-de" maxLength={500} placeholder={t("form.controlsDeHelp")} value={controlsDe} onChange={(e) => setControlsDe(e.target.value)} />

          {profile?.role === "admin" && (
            <label className="check">
              <input id="featured" type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
              {t("form.featured")}
            </label>
          )}
        </div>

        <div className="col">
          <GamePictures
            slug={effectiveSlug}
            value={{ cover: previewCover, image, banner, shots }}
            onChange={(p) => { setCover(p.cover); setImage(p.image); setBanner(p.banner); setShots(p.shots); setDirty(true); }}
            uploaded={uploaded}
            onError={setErr}
            onBusy={setBusy}
          />
        </div>

        {orig && <HelperSetup gameId={orig.id} />}
        {orig && <AchievementsSetup gameId={orig.id} />}
        {orig && <BoardsSetup gameId={orig.id} mainName={orig.board_name} mainNameDe={orig.board_name_de} />}
        {orig && <CosmeticsSetup gameId={orig.id} />}

        <div className="form-foot">
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button className="btn primary" disabled={busy}>{progress !== null ? (fromGit ? t("git.deploying") : t("host.uploadingPct", { pct: Math.round(progress * 100) })) : busy ? t("form.saving") : t("form.save")}</button>
            {/* Back where they came from; opened from a link (nothing to go back to): to their games. */}
            <button type="button" className="btn" onClick={() => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate(orig ? `/game/${orig.slug}` : "/my-games"))}>{t("form.cancel")}</button>
            {orig && (
              confirmDelete ? (
                <button type="button" className="btn danger" onClick={remove} disabled={busy}>{t("form.confirmDelete")}</button>
              ) : (
                <button type="button" className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>{t("form.delete")}</button>
              )
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

/** "Write with AI": the description in English and German, from what's filled in and the game's page. */
function DescribeWithAi({ game, onUse }: { game: Parameters<typeof describeGame>[0]; onUse: (d: { en: string; de: string }) => void }) {
  const { t } = useI18n();
  const on = useAiFeature("describe");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<{ en: string; de: string } | null>(null);
  if (!on) return null;
  const write = async () => {
    if (!game.title) return setErr(t("form.ai.needTitle"));
    setBusy(true);
    setErr("");
    try {
      setDraft(await describeGame(game));
    } catch (e) {
      setErr(t(`assist.err.${assistError(e)}`));
    }
    setBusy(false);
  };
  return (
    <div className="ai-inline">
      <button type="button" className="linkish ai-link" onClick={write} disabled={busy} title={t("form.ai.help")}>
        {busy ? t("assist.writing") : game.description || game.description_de ? t("form.ai.improve") : t("form.ai.write")}
      </button>
      {err && <p className="error" role="alert">{err}</p>}
      {draft && (
        <AiBox title={t("form.ai.draft")} onClose={() => setDraft(null)}>
          <p className="label">English</p>
          <p className="fb-body">{draft.en}</p>
          <p className="label">Deutsch</p>
          <p className="fb-body">{draft.de}</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => { onUse(draft); setDraft(null); }}>{t("assist.use")}</button>
          </div>
        </AiBox>
      )}
    </div>
  );
}
