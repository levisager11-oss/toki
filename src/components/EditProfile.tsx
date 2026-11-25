import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { randomSeed, shrinkImage } from "../lib/avatar";
import { LIMITS, removeAvatarFile, updateProfile, uploadAvatar } from "../lib/social";
import { Avatar } from "./Avatar";
import { SettingRow } from "./SettingRow";

/** The profile picture and the bio, as rows on the account page. */
export function EditProfile() {
  const { t } = useI18n();
  const { profile, reloadProfile } = useAuth();
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "avatar" | "bio">("");
  const [saved, setSaved] = useState<"" | "avatar" | "bio">("");
  if (!profile) return null;

  const run = async (what: "avatar" | "bio", fn: () => Promise<void>) => {
    setErr("");
    setSaved("");
    setBusy(what);
    try {
      await fn();
      reloadProfile();
      setSaved(what);
    } catch {
      setErr(t("soc.avatarError"));
    } finally {
      setBusy("");
    }
  };

  const upload = (file: File) =>
    run("avatar", async () => {
      const small = await shrinkImage(file);
      const url = await uploadAvatar(profile.id, small);
      const old = profile.avatar_url ?? null;
      await updateProfile(profile.id, { avatar_url: url });
      await removeAvatarFile(old); // keep storage small: only the current avatar stays
    });
  const pickPixel = (seed: string | null) =>
    run("avatar", async () => {
      const old = profile.avatar_url ?? null;
      await updateProfile(profile.id, { avatar_url: null, avatar_seed: seed });
      await removeAvatarFile(old);
    });
  const saveBio = (e: FormEvent) => {
    e.preventDefault();
    run("bio", () => updateProfile(profile.id, { bio: bio.trim() }));
  };
  const changed = bio.trim() !== (profile.bio ?? "").trim();

  return (
    <>
      <SettingRow title={t("account.picture")} help={t("account.pictureHelp")}>
        <Avatar person={profile} size={44} />
        <label className="btn small file">
          {t("account.upload")}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={!!busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
        </label>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => pickPixel(randomSeed())}>
          {profile.avatar_url ? t("soc.usePixel") : t("soc.newPixel")}
        </button>
      </SettingRow>
      <SettingRow
        title={t("soc.bio")}
        htmlFor="bio"
        below={
          <form className="set-form" onSubmit={saveBio}>
            <textarea id="bio" rows={2} maxLength={LIMITS.bio} value={bio} onChange={(e) => { setBio(e.target.value); setSaved(""); }} placeholder={t("soc.bioHelp")} />
            <div className="set-form-foot">
              <small className="sub set-count">{bio.length}/{LIMITS.bio}</small>
              {saved === "bio" && <span className="hint saved" role="status">✓ {t("soc.saved")}</span>}
              <button className="btn small primary" disabled={!!busy || !changed}>{busy === "bio" ? t("form.saving") : t("soc.saveBio")}</button>
            </div>
          </form>
        }
      />
      {(err || saved === "avatar") && (
        <p className={err ? "error set-note" : "hint saved set-note"} role={err ? "alert" : "status"}>{err || `✓ ${t("soc.saved")}`}</p>
      )}
    </>
  );
}
