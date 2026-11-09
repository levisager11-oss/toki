import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_SHOTS = 4;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

export function GameForm() {
  const { slug: editSlug } = useParams();
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [orig, setOrig] = useState<Game | null>(null);
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
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  if (missing) return <NotFound />;
  if (editSlug && !orig) return <p className="msg">{t("loading")}</p>;
  if (orig && profile && profile.role !== "admin" && orig.created_by !== profile.id) return <p className="msg">{t("auth.noRights")}</p>;

  const effectiveSlug = slugEdited ? slug : slugify(title);
  const previewCover = cover || coverFor(effectiveSlug || "game", null);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  /** Uploads an image and returns its public link, or null (with an error shown) if it failed. */
  const uploadImage = async (file: File): Promise<string | null> => {
    setErr("");
    if (file.size > MAX_IMAGE) {
      setErr(t("form.imageTooBig"));
      return null;
    }
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${profile!.id}/${crypto.randomUUID()}.${ext}`;
    setBusy(true);
    const { error } = await supabase.storage.from("thumbnails").upload(path, file, { contentType: file.type, upsert: false });
    setBusy(false);
    if (error) {
      setErr(t("form.error"));
      return null;
    }
    return supabase.storage.from("thumbnails").getPublicUrl(path).data.publicUrl;
  };
  const upload = async (file: File) => {
    const link = await uploadImage(file);
    if (link) setImage(link);
  };
  const uploadBanner = async (file: File) => {
    const link = await uploadImage(file);
    if (link) {
      setBannerRatio(null);
      setBanner(link);
    }
  };
  const addShot = async (file: File) => {
    const link = await uploadImage(file);
    if (link) setShots((s) => [...s, link].slice(0, MAX_SHOTS));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const playUrl = url.trim();
    if (!/^https:\/\//i.test(playUrl)) return setErr(t("form.badUrl"));
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
      ? await supabase.from("games").update(row).eq("id", orig.id)
      : await supabase.from("games").insert({ ...row, created_by: profile!.id });
    setBusy(false);
    if (res.error) return setErr(res.error.code === "23505" ? t("form.slugTaken") : t("form.error"));
    invalidateGames();
    navigate(`/game/${row.slug}`);
  };

  const remove = async () => {
    if (!orig) return;
    setBusy(true);
    const { error } = await supabase.from("games").delete().eq("id", orig.id);
    setBusy(false);
    if (error) return setErr(t("form.error"));
    invalidateGames();
    navigate("/my-games");
  };

  return (
    <section className="panel">
      <h1 className="h">{orig ? t("form.editTitle") : t("form.addTitle")}</h1>
      <form className="form two" onSubmit={submit}>
        <div className="col">
          <label htmlFor="title">{t("form.title")}</label>
          <input id="title" required maxLength={60} value={title} onChange={(e) => onTitle(e.target.value)} />

          <label htmlFor="url">{t("form.url")}</label>
          <input id="url" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby="url-help" />
          <small id="url-help">{t("form.urlHelp")}</small>
          <LinkCheck url={url.trim()} isolation={isolation} />
          <label className="check">
            <input id="isolation" type="checkbox" checked={isolation} onChange={(e) => setIsolation(e.target.checked)} aria-describedby="isolation-help" />
            {t("form.isolation")}
          </label>
          <small id="isolation-help">{t("form.isolationHelp")}</small>
          <SaveSupport open={!orig} gameId={orig?.id} />

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

        <div className="form-foot">
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button className="btn primary" disabled={busy}>{busy ? t("form.saving") : t("form.save")}</button>
            <button type="button" className="btn" onClick={() => navigate(-1)}>{t("form.cancel")}</button>
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
