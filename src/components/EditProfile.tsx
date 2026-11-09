import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { randomSeed, shrinkImage } from "../lib/avatar";
import { LIMITS, removeAvatarFile, updateProfile, uploadAvatar } from "../lib/social";
import { Avatar } from "./Avatar";

/** Avatar and bio, on the account page. */
export function EditProfile() {
  const { t } = useI18n();
  const { profile, reloadProfile } = useAuth();
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!profile) return null;

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    setSaved(false);
    setBusy(true);
    try {
      await fn();
      reloadProfile();
      setSaved(true);
    } catch {
      setErr(t("soc.avatarError"));
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File) =>
    run(async () => {
      const small = await shrinkImage(file);
      const url = await uploadAvatar(profile.id, small);
      const old = profile.avatar_url ?? null;
      await updateProfile(profile.id, { avatar_url: url });
      await removeAvatarFile(old); // keep storage small: only the current avatar stays
    });
  const pickPixel = (seed: string | null) =>
    run(async () => {
      const old = profile.avatar_url ?? null;
      await updateProfile(profile.id, { avatar_url: null, avatar_seed: seed });
      await removeAvatarFile(old);
    });
  const saveBio = (e: FormEvent) => {
    e.preventDefault();
    run(() => updateProfile(profile.id, { bio: bio.trim() }));
  };

  return (
    <div className="edit-profile">
      <h2>{t("soc.profile")}</h2>
      <div className="edit-avatar">
        <Avatar person={profile} size={72} />
        <div className="actions">
          <label className="btn file">
            {t("soc.uploadAvatar")}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => pickPixel(randomSeed())}>
            {profile.avatar_url ? t("soc.usePixel") : t("soc.newPixel")}
          </button>
        </div>
      </div>
      <form className="form" onSubmit={saveBio}>
        <label htmlFor="bio">{t("soc.bio")}</label>
        <textarea id="bio" rows={2} maxLength={LIMITS.bio} value={bio} onChange={(e) => setBio(e.target.value)} placeholder={t("soc.bioHelp")} />
        <small>{bio.length}/{LIMITS.bio}</small>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button className="btn" disabled={busy}>{busy ? t("form.saving") : t("soc.saveBio")}</button>
          <Link to={`/u/${profile.username}`} className="btn">{t("soc.viewProfile")}</Link>
          {saved && <span className="hint saved" role="status">✓ {t("soc.saved")}</span>}
        </div>
      </form>
    </div>
  );
}
