import { useState, type MutableRefObject } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { COVERS } from "../pixel/scenes";
import { Cover } from "./Cover";
import { extFor, shrinkGameImage } from "../lib/gameImages";

const MAX_IMAGE = 2 * 1024 * 1024;
export const MAX_SHOTS = 4;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** A game's pictures: a pixel cover or its own cover picture, a banner and screenshots. */
export interface Pictures {
  /** the pixel cover (used while there's no own picture) */
  cover: string;
  image: string | null;
  banner: string | null;
  shots: string[];
}

/**
 * The pictures part of a game's form (the full form, and the AI's "Here's what Toki found").
 * Pictures are shrunk in the browser and uploaded right away; their links go into `uploaded`, so
 * the page can delete the ones that aren't saved with the game.
 */
export function GamePictures({ slug, value, onChange, uploaded, onError, onBusy }: {
  slug: string;
  value: Pictures;
  onChange: (p: Pictures) => void;
  uploaded: MutableRefObject<string[]>;
  onError: (msg: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  // Shape of the uploaded banner (width / height), to warn when it isn't wide.
  const [bannerRatio, setBannerRatio] = useState<number | null>(null);
  const { cover, image, banner, shots } = value;
  const set = (p: Partial<Pictures>) => onChange({ ...value, ...p });

  /** Shrinks a picture to at most maxSide pixels, uploads it and returns its public link, or null (with an error shown). */
  const uploadImage = async (file: File, maxSide: number): Promise<string | null> => {
    onError("");
    onBusy?.(true);
    try {
      const blob = await shrinkGameImage(file, maxSide);
      if (blob.size > MAX_IMAGE) {
        onError(t("form.imageTooBig"));
        return null;
      }
      const path = `${profile!.id}/${crypto.randomUUID()}.${extFor(blob.type || file.type)}`;
      const { error } = await supabase.storage.from("thumbnails").upload(path, blob, { contentType: blob.type || file.type, upsert: false });
      if (error) {
        onError(t("form.error"));
        return null;
      }
      const link = supabase.storage.from("thumbnails").getPublicUrl(path).data.publicUrl;
      uploaded.current.push(link);
      return link;
    } finally {
      onBusy?.(false);
    }
  };
  const pick = (go: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) go(f);
  };
  const upload = async (file: File) => {
    const link = await uploadImage(file, 1200);
    if (link) set({ image: link });
  };
  const uploadBanner = async (file: File) => {
    const link = await uploadImage(file, 2000);
    if (link) {
      setBannerRatio(null);
      set({ banner: link });
    }
  };
  const addShot = async (file: File) => {
    const link = await uploadImage(file, 1920);
    if (link) set({ shots: [...shots, link].slice(0, MAX_SHOTS) });
  };

  return (
    <>
      <span className="label-text" id="cover-label">{t("form.cover")}</span>
      <div className="cover-preview">
        <Cover slug={slug || "game"} cover={cover} image={image} />
      </div>
      <small>{t("form.coverHelp")}</small>
      <div className="cover-pick" role="radiogroup" aria-labelledby="cover-label">
        {COVERS.map((c) => (
          <button type="button" key={c} role="radio" aria-checked={!image && cover === c} aria-label={c} className={!image && cover === c ? "on" : ""} onClick={() => set({ image: null, cover: c })}>
            <Cover slug={slug || "game"} cover={c} />
          </button>
        ))}
      </div>
      <div className="actions">
        <label className="btn file">
          {t("form.upload")}
          <input id="image" type="file" accept={IMAGE_TYPES} onChange={pick(upload)} />
        </label>
        {image && <button type="button" className="btn" onClick={() => set({ image: null })}>{t("form.removeImage")}</button>}
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
          <input id="banner" type="file" accept={IMAGE_TYPES} aria-describedby="banner-help" onChange={pick(uploadBanner)} />
        </label>
        {banner && <button type="button" className="btn" onClick={() => set({ banner: null })}>{t("form.removeBanner")}</button>}
      </div>

      <span className="label-text" id="shots-label">{t("form.screenshots")}</span>
      <small>{t("form.screenshotsHelp")}</small>
      <ul className="shot-pick" aria-labelledby="shots-label">
        {shots.map((src, n) => (
          <li key={src}>
            <img src={src} alt="" />
            <button type="button" className="shot-remove" aria-label={t("form.removeScreenshot", { n: n + 1 })} onClick={() => set({ shots: shots.filter((x) => x !== src) })}>×</button>
          </li>
        ))}
      </ul>
      {shots.length < MAX_SHOTS && (
        <div className="actions">
          <label className="btn file">
            {t("form.addScreenshot")}
            <input type="file" accept={IMAGE_TYPES} onChange={pick(addShot)} />
          </label>
        </div>
      )}
    </>
  );
}
