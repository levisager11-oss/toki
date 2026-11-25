import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cosmeticName, equipCosmetic, refreshLook, shopErrorKey, useCatalog, useLook, WEAR_COLUMN, type Cosmetic, type WearKind } from "../lib/cosmetics";
import { useI18n, type Key } from "../lib/i18n";
import { STICKER_PACKS } from "../lib/stickers";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { Name, Sticker, ThemeBand } from "./Looks";
import { ReportButton } from "./ReportButton";

type Person = { id: string; username: string; avatar_url?: string | null; avatar_seed?: string | null };

/** What a cosmetic looks like, on this player. */
export function CosmeticPreview({ c, person }: { c: Cosmetic; person: Person }) {
  if (c.kind === "frame") return <span className="cos-prev"><Avatar person={person} size={44} frameId={c.id} /></span>;
  if (c.kind === "color") return <span className="cos-prev"><Name person={person} colorId={c.id} titleId={null} /></span>;
  if (c.kind === "title") return <span className="cos-prev"><Name person={person} colorId={null} titleId={c.id} /></span>;
  if (c.kind === "theme") return <ThemeBand style={c.style} className="cos-prev theme-prev" />;
  const names = Object.keys(STICKER_PACKS[c.style.pack ?? ""] ?? {}).slice(0, 3);
  return <span className="cos-prev">{names.map((n) => <Sticker key={n} pack={c.style.pack!} name={n} size={34} />)}</span>;
}

/** A cosmetic: its look, its name, where it's from, and whatever goes below (a price, a button). */
export function CosmeticTile({ c, person, games, children, on }: { c: Cosmetic; person: Person; games?: Map<string, Game>; children?: ReactNode; on?: boolean }) {
  const { t, lang } = useI18n();
  const game = c.game_id ? games?.get(c.game_id) : undefined;
  return (
    <li className={`cos-tile${on ? " on" : ""}`}>
      <CosmeticPreview c={c} person={person} />
      <span className="cos-name">{cosmeticName(c, lang)}</span>
      <span className="sub">
        {t(`shop.kind.${c.kind}` as Key)}
        {game && <> · <Link to={`/game/${game.slug}`}>{game.title}</Link></>}
      </span>
      {children}
    </li>
  );
}

/** The cosmetics a player has, on their profile. Their own page: buttons to put them on. */
export function Collection({ ids, person, self, games }: { ids: Set<string>; person: Person; self: boolean; games: Map<string, Game> }) {
  const { t } = useI18n();
  const catalog = useCatalog();
  const look = useLook(person.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!catalog) return null;
  const items = [...ids].map((id) => catalog.get(id)).filter((c): c is Cosmetic => !!c);
  const wearing = (c: Cosmetic) => c.kind !== "stickers" && look?.[WEAR_COLUMN[c.kind as WearKind]] === c.id;
  const wear = async (c: Cosmetic) => {
    if (c.kind === "stickers") return;
    setBusy(true);
    setErr("");
    try {
      await equipCosmetic(c.kind, wearing(c) ? null : c.id);
      refreshLook(person.id);
    } catch (e) {
      setErr(t(shopErrorKey(e) as Key));
    }
    setBusy(false);
  };
  return (
    <section id="collection" className="collection-sec">
      <div className="sechead">
        <h2>{t("shop.collection")}</h2>
        {self && <Link to="/shop" className="btn">{t("shop.title")}</Link>}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      <ul className="cos-grid">
        {items.map((c) => (
          <CosmeticTile key={c.id} c={c} person={person} games={games} on={wearing(c)}>
            {self && c.kind !== "stickers" && (
              <button type="button" className={`btn small${wearing(c) ? "" : " primary"}`} aria-pressed={wearing(c)} disabled={busy} onClick={() => wear(c)}>
                {t(wearing(c) ? "shop.takeOff" : "shop.wear")}
              </button>
            )}
            {!self && wearing(c) && <span className="sub">{t("shop.wearing")}</span>}
            {!self && c.game_id && c.ref && <ReportButton kind="cosmetic" target={c.ref} />}
          </CosmeticTile>
        ))}
      </ul>
    </section>
  );
}
