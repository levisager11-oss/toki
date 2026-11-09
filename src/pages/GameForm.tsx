import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { getGame, slugify } from "../lib/games";
import { invalidateGames } from "../lib/useGames";
import { CATEGORIES, type Category, type Game } from "../lib/types";
import { COVERS, coverFor } from "../pixel/scenes";
import { Cover } from "../components/Cover";
import { NotFound } from "./NotFound";
import { LinkCheck } from "../components/LinkCheck";
import { SaveSupport } from "../components/SaveSupport";
import { AiBox } from "../components/AiBits";
import { HelperSetup } from "../components/HelperSetup";
import { assistError, describeGame, useFreeAi } from "../lib/assist";
import { useTitle } from "../lib/useTitle";
import { extFor, removeGameImages, shrinkGameImage } from "../lib/gameImages";
import { HostedUpload, type Picked } from "../components/HostedUpload";
import { ImportFromLink } from "../components/ImportFromLink";
import { gitConnect, gitDisconnect, hostError, unhostGame, uploadGame, useHosting, type GitChoice, type GitRow, type Imported } from "../lib/hosting";
import { GitHubFollow } from "../components/GitHubFollow";
import { QuickAdd, type QuickCarry } from "../components/QuickAdd";

// Developers who chose "Advanced" get the full form straight away next time (this browser only).
const ADVANCED_KEY = "toki.addAdvanced";
const prefersAdvanced = () => {
  try {
    return localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
};
const rememberAdvanced = (on: boolean) => {
  try {
    if (on) localStorage.setItem(ADVANCED_KEY, "1");
    else localStorage.removeItem(ADVANCED_KEY);
  } catch {
    /* only a convenience */
  }
};
import { siteFor, siteUrl } from "../lib/hostingRules";

const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_SHOTS = 4;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

export function GameForm() {
  const { slug: editSlug } = useParams();
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const hosting = useHosting();
  const freeAi = useFreeAi();
  const [orig, setOrig] = useState<Game | null>(null);
  useTitle(editSlug ? t("form.editTitle") : t("form.addTitle"));
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionDe, setDescriptionDe] = useState("");
  const [controls, setControls] = useState("");
  const [category, setCategory] = useState<Category>("action");
  const [engine, setEngine] = useState("");
  const [cover, setCover] = useState<string>("");
  const [image, setImage] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // Shape of the uploaded banner (width / height), to warn when it isn't wide.
  const [bannerRatio, setBannerRatio] = useState<number | null>(null);
  const [featured, setFeatured] = useState(false);
  const [isolation, setIsolation] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  const [scoreOrder, setScoreOrder] = useState<"high" | "low">("high");
  const [scoreFormat, setScoreFormat] = useState<"points" | "time">("points");
  const [err, setErr] = useState<string>((location.state as { uploadError?: string } | null)?.uploadError ?? "");
  // Where the game runs: uploaded to Toki, from a GitHub branch, or a link to elsewhere (null: not picked yet).
  const [mode, setMode] = useState<"upload" | "github" | "link" | null>(null);
  const [git, setGit] = useState<GitRow | null>(null);
  const [gitChoice, setGitChoice] = useState<GitChoice | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // New games: the one-click way first; "fill in everything yourself" shows this form.
  const [manual, setManual] = useState(prefersAdvanced);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    });
  }, [editSlug]);

  /** "Advanced": the full form, filled in with what the one-click screen had so far. */
  const toAdvanced = (c: QuickCarry) => {
    rememberAdvanced(true);
    setManual(true);
    const p = c.proposal;
    if (p) {
      setTitle(p.title);
      setSlug(slugify(p.title));
      setDescription(p.description);
      setDescriptionDe(p.description_de);
      setControls(p.controls);
      setCategory(p.category);
      setEngine(p.engine);
      setScoreOrder(p.score_order);
      setScoreFormat(p.score_format);
      setIsolation(p.isolation);
      setDirty(true);
    }
    if (c.kind === "github") {
      setMode("github");
      if (c.git) setGitChoice(c.git);
    } else {
      setMode("upload");
      if (c.picked) setPicked(c.picked);
    }
  };
  const toQuick = () => {
    rememberAdvanced(false);
    setManual(false);
  };

  if (missing) return <NotFound />;
  if (!editSlug && !manual) {
    if (hosting === null) return <p className="msg" aria-busy="true">{t("loading")}</p>;
    if (hosting.enabled && hosting.domain) return <QuickAdd hosting={hosting} onManual={toAdvanced} />;
  }
  if (editSlug && !orig) return <p className="msg">{t("loading")}</p>;
  if (orig && profile && profile.role !== "admin" && orig.created_by !== profile.id) return <p className="msg">{t("auth.noRights")}</p>;

  const effectiveSlug = slugEdited ? slug : slugify(title);
  // Hosted on Toki right now: its link is its own address there.
  const wasHosted = !!orig?.hosted_site && hostOf(orig.play_url).startsWith(`${orig.hosted_site}.`);
  const canHost = !!hosting?.enabled && !!hosting.domain;
  const effMode = mode ?? (orig ? (git ? "github" : wasHosted ? "upload" : "link") : canHost ? "upload" : "link");
  const hosted = effMode !== "link" && (canHost || wasHosted);
  const fromGit = hosted && effMode === "github";
  const previewCover = cover || coverFor(effectiveSlug || "game", null);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  /**
   * Shrinks a picture to at most maxSide pixels, uploads it and returns its public link,
   * or null (with an error shown) if it failed.
   */
  const uploadImage = async (file: File, maxSide: number): Promise<string | null> => {
    setErr("");
    setBusy(true);
    try {
      const blob = await shrinkGameImage(file, maxSide);
      if (blob.size > MAX_IMAGE) {
        setErr(t("form.imageTooBig"));
        return null;
      }
      const path = `${profile!.id}/${crypto.randomUUID()}.${extFor(blob.type || file.type)}`;
      const { error } = await supabase.storage.from("thumbnails").upload(path, blob, { contentType: blob.type || file.type, upsert: false });
      if (error) {
        setErr(t("form.error"));
        return null;
      }
      const link = supabase.storage.from("thumbnails").getPublicUrl(path).data.publicUrl;
      uploaded.current.push(link);
      return link;
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File) => {
    const link = await uploadImage(file, 1200);
    if (link) setImage(link);
  };
  const uploadBanner = async (file: File) => {
    const link = await uploadImage(file, 2000);
    if (link) {
      setBannerRatio(null);
      setBanner(link);
    }
  };
  const addShot = async (file: File) => {
    const link = await uploadImage(file, 1920);
    if (link) setShots((s) => [...s, link].slice(0, MAX_SHOTS));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    let playUrl = url.trim();
    if (hosted) {
      if (fromGit ? !git && !gitChoice?.branch : !picked && !wasHosted) return setErr(t(fromGit ? "git.pickFirst" : "host.err.pickFirst"));
      if (!wasHosted && !hosting?.domain) return setErr(t("host.err.hosting_off"));
      // Until the upload is done; the server then sets the real address.
      playUrl = wasHosted && orig ? orig.play_url : siteUrl(siteFor(effectiveSlug), hosting!.domain!);
    } else if (!/^https:\/\//i.test(playUrl)) return setErr(t("form.badUrl"));
    const row = {
      slug: effectiveSlug,
      title: title.trim(),
      play_url: playUrl,
      description: description.trim(),
      description_de: descriptionDe.trim() || null,
      controls: controls.trim(),
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
        if (!r.ok) msg = t("git.failed", { error: r.error ?? "" });
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

  /** "Fill in from a link": fills the fields that are still empty, then lets the free AI write both descriptions. */
  const applyImport = async (d: Imported) => {
    setDirty(true);
    if (d.title && !title.trim()) onTitle(d.title);
    if (d.description && !description.trim()) setDescription(d.description);
    if (d.toki?.description_de && !descriptionDe.trim()) setDescriptionDe(d.toki.description_de);
    if (d.controls && !controls.trim()) setControls(d.controls);
    if (d.category && !orig) setCategory(d.category);
    if (d.engine && !engine.trim()) setEngine(d.engine);
    if (d.isolation !== null) setIsolation(d.isolation);
    if (d.thumbnail_url && !image) setImage(d.thumbnail_url);
    if (d.screenshots.length && !shots.length) setShots(d.screenshots.slice(0, MAX_SHOTS));
    if (d.toki?.score_order) setScoreOrder(d.toki.score_order);
    if (d.toki?.score_format) setScoreFormat(d.toki.score_format);
    if (d.play_url && !wasHosted) {
      setUrl(d.play_url);
      setMode("link");
    }
    const theTitle = title.trim() || d.title;
    if (freeAi && theTitle && !descriptionDe.trim() && !d.toki?.description_de) {
      try {
        const out = await describeGame({
          title: theTitle, category: d.category ?? category, engine: engine.trim() || d.engine || "", controls: controls.trim() || d.controls,
          description: description.trim() || d.description, description_de: "", play_url: d.play_url ?? "",
        });
        if (!description.trim() && !d.description) setDescription(out.en);
        setDescriptionDe(out.de);
      } catch {
        /* the AI is optional here */
      }
    }
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
        {!orig && canHost && <button type="button" className="btn" onClick={toQuick}>{t("quick.backToQuick")}</button>}
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
              {fromGit ? (
                <GitHubFollow gameId={orig?.id} row={git} choice={gitChoice} onChoice={(c) => { setGitChoice(c); setDirty(true); }} onChanged={() => orig && loadGit(orig.id)} />
              ) : (
                <HostedUpload picked={picked} onPick={(p) => { setPicked(p); setDirty(true); }} gameId={orig?.id} hosted={wasHosted ? orig!.play_url : null} progress={progress} />
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

          {profile?.role === "admin" && (
            <label className="check">
              <input id="featured" type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
              {t("form.featured")}
            </label>
          )}
        </div>

        <div className="col">
          <span className="label-text" id="cover-label">{t("form.cover")}</span>
          <div className="cover-preview">
            <Cover slug={effectiveSlug || "game"} cover={previewCover} image={image} />
          </div>
          <small>{t("form.coverHelp")}</small>
          <div className="cover-pick" role="radiogroup" aria-labelledby="cover-label">
            {COVERS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={!image && previewCover === c} aria-label={c} className={!image && previewCover === c ? "on" : ""} onClick={() => { setImage(null); setCover(c); }}>
                <Cover slug={effectiveSlug || "game"} cover={c} />
              </button>
            ))}
          </div>
          <div className="actions">
            <label className="btn file">
              {t("form.upload")}
              <input id="image" type="file" accept={IMAGE_TYPES} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
            </label>
            {image && <button type="button" className="btn" onClick={() => setImage(null)}>{t("form.removeImage")}</button>}
          </div>

          <span className="label-text" id="banner-label">{t("form.banner")}</span>
          <small id="banner-help">{t("form.bannerHelp")}</small>
          {banner && (
            <>
              <div className="banner-preview">
                <img src={banner} alt="" onLoad={(e) => setBannerRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
              </div>
              {bannerRatio !== null && Math.abs(bannerRatio - 2) > 0.2 && <p className="check warn">{t("form.bannerShape")}</p>}
            </>
          )}
          <div className="actions">
            <label className="btn file">
              {t("form.uploadBanner")}
              <input id="banner" type="file" accept={IMAGE_TYPES} aria-describedby="banner-help" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadBanner(f); }} />
            </label>
            {banner && <button type="button" className="btn" onClick={() => setBanner(null)}>{t("form.removeBanner")}</button>}
          </div>

          <span className="label-text" id="shots-label">{t("form.screenshots")}</span>
          <small>{t("form.screenshotsHelp")}</small>
          <ul className="shot-pick" aria-labelledby="shots-label">
            {shots.map((src, n) => (
              <li key={src}>
                <img src={src} alt="" />
                <button type="button" className="shot-remove" aria-label={t("form.removeScreenshot", { n: n + 1 })} onClick={() => setShots((s) => s.filter((x) => x !== src))}>×</button>
              </li>
            ))}
          </ul>
          {shots.length < MAX_SHOTS && (
            <div className="actions">
              <label className="btn file">
                {t("form.addScreenshot")}
                <input type="file" accept={IMAGE_TYPES} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addShot(f); }} />
              </label>
            </div>
          )}
        </div>

        {orig && <HelperSetup gameId={orig.id} />}

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

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

/** "Write with AI": the description in English and German, from what's filled in and the game's page. */
function DescribeWithAi({ game, onUse }: { game: Parameters<typeof describeGame>[0]; onUse: (d: { en: string; de: string }) => void }) {
  const { t } = useI18n();
  const on = useFreeAi();
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
