import { useEffect, useState, type KeyboardEvent } from "react";
import { useI18n, type Key } from "../lib/i18n";
import { gameAchievements, type AchievementRow } from "../lib/achievements";
import {
  GAME_FRAME_STYLES, GAME_THEME_PATTERNS, loadCatalog, setGameCosmetics, shopErrorKey, type Cosmetic, type FrameStyle, type Style, type ThemePattern, type WearKind,
} from "../lib/cosmetics";
import { useAuth } from "../lib/auth";
import { CosmeticPreview } from "./Collection";

type Draft = { id?: string; kind: WearKind; name: string; name_de: string; style: Style; achievement: string };

const MAX = 5;
const KIND_LIST: WearKind[] = ["frame", "color", "title", "theme"];
const defaultStyle = (kind: WearKind): Style =>
  kind === "frame" ? { style: "ring", a: "#ff7a59", b: "#ffc531" } : kind === "color" ? { a: "#2e8fe6" } : kind === "theme" ? { a: "#1f6f4a", b: "#8fd694", pattern: "dots" } : {};

/**
 * For the game's developer, on its form: up to 5 cosmetics of the game's own (a frame, a name
 * color, a title or a profile theme), each given to players with one of its achievements.
 * Saved on their own, like the achievements.
 */
export function CosmeticsSetup({ gameId }: { gameId: string }) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const [list, setList] = useState<Draft[] | null>(null);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([loadCatalog(true), gameAchievements(gameId)]).then(
      ([catalog, ach]) => {
        if (!alive) return;
        setAchievements(ach);
        setList([...catalog.values()].filter((c) => c.game_id === gameId).map((c) => ({
          id: c.id, kind: c.kind as WearKind, name: c.name, name_de: c.name_de ?? "", style: c.style, achievement: c.achievement ?? "",
        })));
      },
      () => alive && setList([]),
    );
    return () => {
      alive = false;
    };
  }, [gameId]);

  if (!list) return null;
  const change = (i: number, patch: Partial<Draft>) => {
    setMsg("");
    setList((l) => l!.map((d, n) => (n === i ? { ...d, ...patch } : d)));
  };
  const setStyle = (i: number, patch: Partial<Style>) => change(i, { style: { ...list[i].style, ...patch } });
  const noSubmit = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
  };

  const save = async () => {
    setErr("");
    setMsg("");
    if (list.some((d) => !d.name.trim() || !d.achievement)) return setErr(t("gcos.err.missing"));
    setBusy(true);
    try {
      const saved = await setGameCosmetics(gameId, list.map((d) => ({
        id: d.id, kind: d.kind, name: d.name.trim(), name_de: d.name_de.trim() || null, style: d.kind === "title" ? {} : d.kind === "color" ? { a: d.style.a } : d.style, achievement: d.achievement,
      })));
      setList(saved.map((c) => ({ id: c.id, kind: c.kind as WearKind, name: c.name, name_de: c.name_de ?? "", style: c.style, achievement: c.achievement ?? "" })));
      setMsg(t("gcos.saved"));
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    }
    setBusy(false);
  };

  const person = profile ?? { id: "", username: t("shop.you") };
  const preview = (d: Draft): Cosmetic => ({
    id: d.id ?? "preview", kind: d.kind, name: d.name || "…", name_de: d.name_de || null, price: null, min_level: 1,
    style: d.style, game_id: gameId, achievement: d.achievement, position: 0, active: true,
  });

  return (
    <details id="cosmetics" className="helper-setup cos-setup" open={list.length > 0 || location.hash === "#cosmetics"} onKeyDown={noSubmit}>
      <summary><b>{t("gcos.title")}</b>{list.length > 0 && <span className="sub"> · {list.length}/{MAX}</span>}</summary>
      <div className="ai-panel">
        <small>{t("gcos.lead")} {t("gcos.shopOnly")}</small>
        {achievements.length === 0 ? (
          <p className="check">{t("gcos.needAchievements")}</p>
        ) : (
          <>
            <ol className="ach-edit">
              {list.map((d, i) => (
                <li key={d.id ?? `new-${i}`}>
                  <div className="cos-edit-head">
                    <CosmeticPreview c={preview(d)} person={person} />
                    <select aria-label={t("gcos.kind")} value={d.kind} onChange={(e) => {
                      const kind = e.target.value as WearKind;
                      change(i, { kind, style: defaultStyle(kind) });
                    }}>
                      {KIND_LIST.map((k) => <option key={k} value={k}>{t(`shop.kind.${k}` as Key)}</option>)}
                    </select>
                  </div>
                  <div className="pair">
                    <input aria-label={t("gcos.name")} placeholder={t("gcos.name")} value={d.name} maxLength={30} onChange={(e) => change(i, { name: e.target.value })} />
                    <input aria-label={t("gcos.nameDe")} placeholder={t("gcos.nameDe")} value={d.name_de} maxLength={30} onChange={(e) => change(i, { name_de: e.target.value })} />
                  </div>
                  {d.kind !== "title" && (
                    <div className="cos-edit-style">
                      {d.kind === "frame" && (
                        <select aria-label={t("gcos.look")} value={d.style.style ?? "ring"} onChange={(e) => setStyle(i, { style: e.target.value as FrameStyle })}>
                          {GAME_FRAME_STYLES.map((s) => <option key={s} value={s}>{t(`gcos.frame.${s}` as Key)}</option>)}
                        </select>
                      )}
                      {d.kind === "theme" && (
                        <select aria-label={t("gcos.look")} value={d.style.pattern ?? "plain"} onChange={(e) => setStyle(i, { pattern: e.target.value as ThemePattern })}>
                          {GAME_THEME_PATTERNS.map((p) => <option key={p} value={p}>{t(`gcos.pattern.${p}` as Key)}</option>)}
                        </select>
                      )}
                      {!(d.kind === "frame" && d.style.style === "rainbow") && (
                        <label className="sub">{t("gcos.color1")} <input type="color" value={d.style.a ?? "#ff7a59"} onChange={(e) => setStyle(i, { a: e.target.value })} /></label>
                      )}
                      {(d.kind === "theme" || (d.kind === "frame" && d.style.style !== "rainbow" && d.style.style !== "dashed")) && (
                        <label className="sub">{t("gcos.color2")} <input type="color" value={d.style.b ?? d.style.a ?? "#ffc531"} onChange={(e) => setStyle(i, { b: e.target.value })} /></label>
                      )}
                    </div>
                  )}
                  <div className="ach-edit-foot">
                    <label className="sub" htmlFor={`cos-ach-${i}`}>{t("gcos.achievement")}</label>
                    <select id={`cos-ach-${i}`} value={d.achievement} onChange={(e) => change(i, { achievement: e.target.value })}>
                      <option value="">{t("gcos.pick")}</option>
                      {achievements.map((a) => <option key={a.id} value={a.id}>{a.icon} {(lang === "de" && a.name_de) || a.name}</option>)}
                    </select>
                    <button type="button" className="linkish danger-text" onClick={() => setList((l) => l!.filter((_, n) => n !== i))}>{t("ach.setup.remove")}</button>
                  </div>
                </li>
              ))}
            </ol>
            {list.length < MAX && (
              <button type="button" className="btn" onClick={() => setList((l) => [...l!, { kind: "frame", name: "", name_de: "", style: defaultStyle("frame"), achievement: achievements[0]?.id ?? "" }])}>
                {t("gcos.add")}
              </button>
            )}
            <small>{t("gcos.removeHelp")}</small>
            {msg && <p className="check good" role="status">{msg}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="actions">
              <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? t("ach.setup.saving") : t("gcos.save")}</button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
