import { useId, type CSSProperties, type ReactNode } from "react";
import { cosmeticName, useCatalog, useLook, type Cosmetic, type Style } from "../lib/cosmetics";
import { useI18n } from "../lib/i18n";
import { stickerCells } from "../lib/stickers";

// How cosmetics look: avatar frames, name colors, titles, profile themes and stickers. Each is
// drawn from its small "style" (a pattern and one or two colors), with CSS in styles.css
// (.frame-*, .theme-*). Animations stop for players who asked for less motion.

type Vars = CSSProperties & Record<`--${string}`, string>;

const vars = (s: Style | undefined, prefix: string): Vars => {
  const v: Vars = {};
  if (s?.a) v[`--${prefix}a`] = s.a;
  if (s?.b ?? s?.a) v[`--${prefix}b`] = (s?.b ?? s?.a)!;
  return v;
};

/** The frame around an avatar (inside .avatar, which is position: relative). */
export function FrameRing({ style }: { style: Style | undefined }) {
  if (!style?.style) return null;
  const v = vars(style, "f");
  const kind = style.style;
  return (
    <>
      {kind === "glow" && <i className="av-frame av-frame-halo" style={v} aria-hidden="true" />}
      <i className={`av-frame av-frame-${kind}`} style={v} aria-hidden="true" />
      {kind === "double" && <i className="av-frame av-frame-outer" style={v} aria-hidden="true" />}
    </>
  );
}

/** The cosmetic with this id, if it is in the catalog. */
export function useCosmetic(id: string | null | undefined): Cosmetic | undefined {
  const catalog = useCatalog();
  return id ? catalog?.get(id) : undefined;
}

/** A player's frame, from their look (or the one given, for previews). */
export function useFrameStyle(personId: string | null | undefined, frameId?: string | null): Style | undefined {
  const look = useLook(frameId === undefined ? personId : null);
  const id = frameId === undefined ? look?.frame : frameId;
  return useCosmetic(id)?.style;
}

/** A username in the player's name color, with their title after it. */
export function Name({ person, title = true, at = true, colorId, titleId }: {
  person: { id?: string | null; user_id?: string | null; username: string } | null | undefined;
  /** show the title */
  title?: boolean;
  /** "@" before the name */
  at?: boolean;
  /** for previews: this color and title instead of the player's own */
  colorId?: string | null;
  titleId?: string | null;
}) {
  const { lang } = useI18n();
  const id = person?.id ?? person?.user_id ?? null;
  const look = useLook(colorId === undefined && titleId === undefined ? id : null);
  const color = useCosmetic(colorId === undefined ? look?.name_color : colorId);
  const shownTitle = useCosmetic(titleId === undefined ? look?.title : titleId);
  const s = color?.style;
  const style: Vars | undefined = s?.a ? (s.b && s.b !== s.a ? { ...vars(s, "n") } : { color: s.a }) : undefined;
  return (
    <>
      <b className={s?.b && s.b !== s.a ? "name name-grad" : "name"} style={style}>{at ? "@" : ""}{person?.username ?? "…"}</b>
      {title && shownTitle && <span className="p-title">{cosmeticName(shownTitle, lang)}</span>}
    </>
  );
}

/** "Lv 5" */
export function LevelBadge({ level, big }: { level: number | undefined; big?: boolean }) {
  const { t } = useI18n();
  if (!level) return null;
  return <span className={`lv-badge${big ? " big" : ""}`} title={t("lv.level", { n: level })}>{t("lv.short", { n: level })}</span>;
}

/** A player's level next to their name, from their look. */
export function PlayerLevel({ id }: { id: string | null | undefined }) {
  const look = useLook(id);
  return <LevelBadge level={look?.level} />;
}

/** The band at the top of a profile, in the player's theme (or Toki's plain one). */
export function ThemeBand({ style, children, className = "" }: { style: Style | undefined; children?: ReactNode; className?: string }) {
  const pattern = style?.pattern ?? "plain";
  return (
    <div className={`theme-band ${style ? `theme-${pattern}` : "theme-none"} ${className}`} style={vars(style, "t")}>
      {children}
    </div>
  );
}

/** A chat sticker. */
export function Sticker({ pack, name, size = 96, label }: { pack: string; name: string; size?: number; label?: string }) {
  const cells = stickerCells(pack, name);
  if (!cells) return null;
  return (
    <svg className="sticker" viewBox="0 0 10 10" width={size} height={size} shapeRendering="crispEdges" role="img" aria-label={label ?? name}>
      {cells.map((c) => <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" fill={c.color} />)}
    </svg>
  );
}

/** Toki Tokens: the coin and the number. */
export function Tokens({ n, className = "" }: { n: number | null | undefined; className?: string }) {
  const { t, lang } = useI18n();
  return (
    <span className={`tokens ${className}`} title={t("tok.name")}>
      <TokenCoin />
      <span>{n === null || n === undefined ? "…" : n.toLocaleString(lang === "de" ? "de-CH" : "en-GB")}</span>
    </span>
  );
}

export function TokenCoin({ size = 14 }: { size?: number }) {
  return (
    <svg className="coin" viewBox="0 0 7 7" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      <path d="M2 0h3v1h1v1h1v3h-1v1h-1v1h-3v-1h-1v-1h-1v-3h1v-1h1z" fill="#b8860b" />
      <path d="M2 1h3v1h1v3h-1v1h-3v-1h-1v-3h1z" fill="#ffc531" />
      <path d="M3 2h1v3h-1z" fill="#fff3b0" />
    </svg>
  );
}

/** Stars from 1 to 5 (halves for an average). */
export function Stars({ value, size = 14, label, count = 5 }: { value: number; size?: number; label?: string; count?: number }) {
  const uid = useId();
  const full = Math.round(value * 2) / 2;
  return (
    <span className="stars" {...(label === "" ? { "aria-hidden": true } : { role: "img", "aria-label": label ?? `${value.toFixed(1)} / 5` })}>
      {Array.from({ length: count }, (_, k) => k + 1).map((i) => (
        <svg key={i} viewBox="0 0 10 10" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
          <defs>
            <clipPath id={`half${uid}-${i}`}><rect x="0" y="0" width="5" height="10" /></clipPath>
          </defs>
          <path d={STAR} className="star-off" />
          {full >= i ? <path d={STAR} className="star-on" /> : full >= i - 0.5 ? <path d={STAR} className="star-on" clipPath={`url(#half${uid}-${i})`} /> : null}
        </svg>
      ))}
    </span>
  );
}
const STAR = "M4 0h2v3h4v2h-1v1h-1v1h1v3h-2v-1h-1v-1h-2v1h-1v1h-2v-3h1v-1h-1v-1h-1v-2h4z";
