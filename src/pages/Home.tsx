import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { clearRecent, useRecent } from "../lib/local";
import { useGames } from "../lib/useGames";
import { matches, plays, SORTS, sortGames, type Sort } from "../lib/games";
import { Cover } from "../components/Cover";
import { GameCard, GameGrid, GridSkeleton, Plays, RecentItem } from "../components/GameCard";
import { useAuth } from "../lib/auth";
import { suggestions, useFreeAi, type Suggestion } from "../lib/assist";
import { PlayIcon } from "../components/icons";
import { useLatestUpdates } from "../lib/releases";
import { Avatar } from "../components/Avatar";
import { isOnline, myFriends, type FriendRow } from "../lib/social";
import type { Category, Game } from "../lib/types";

const ROTATE_MS = 8000;
const MAX_SLIDES = 4;
const SORT_KEY = "toki.sort";
function savedSort(): Sort {
  try {
    const s = localStorage.getItem(SORT_KEY);
    return (SORTS as readonly string[]).includes(s ?? "") ? (s as Sort) : "new";
  } catch {
    return "new";
  }
}

export function Home() {
  const { t } = useI18n();
  const { games, error } = useGames();
  const recentSlugs = useRecent();
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  // In the address, so going back to the list keeps the chosen category.
  const cat = (params.get("cat") as Category | null) ?? "all";
  const setCat = (c: Category | "all") =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (c === "all") next.delete("cat");
        else next.set("cat", c);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  const [sort, setSortState] = useState<Sort>(savedSort);
  const updates = useLatestUpdates();
  const setSort = (v: Sort) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* only a convenience */
    }
  };

  // The admin's featured game first, then the most played ones.
  const slides = useMemo(() => {
    if (!games?.length) return [];
    const rest = games.filter((g) => !g.featured).sort((a, b) => plays(b) - plays(a));
    return [...games.filter((g) => g.featured), ...rest].slice(0, MAX_SLIDES);
  }, [games]);
  const recent = useMemo(
    () => (games ? recentSlugs.map((s) => games.find((g) => g.slug === s)).filter((g): g is Game => !!g).slice(0, 6) : []),
    [games, recentSlugs],
  );
  const cats = useMemo(() => [...new Set((games ?? []).map((g) => g.category))].sort(), [games]);
  const shown = useMemo(
    () => sortGames((games ?? []).filter((g) => (cat === "all" || g.category === cat) && matches(g, q, t(`cat.${g.category}`))), sort, updates),
    [games, cat, q, t, sort, updates],
  );

  if (error) return <p className="msg">{t("error")}</p>;
  if (!games)
    return (
      <>
        <section className="feature skel" aria-busy="true" aria-label={t("loading")}>
          <div className="cover" />
          <div className="txt"><span className="bar" style={{ width: "30%" }} /><span className="bar big" /><span className="bar" style={{ width: "80%" }} /></div>
        </section>
        <section><GridSkeleton /></section>
      </>
    );
  if (!games.length) return <p className="msg">{t("home.empty")}</p>;

  return (
    <>
      {!q && slides.length > 0 && <Featured slides={slides} />}

      {!q && recent.length > 0 && (
        <section>
          <div className="sechead">
            <h2>{t("home.recent")}</h2>
            <button type="button" className="linkish sub" onClick={clearRecent}>{t("home.clearRecent")}</button>
          </div>
          <div className="recent">
            {recent.map((g) => <RecentItem key={g.id} game={g} />)}
          </div>
        </section>
      )}

      {!q && <FriendsPlaying games={games} />}

      {!q && <Suggested games={games} recentSlugs={recentSlugs} />}

      <section id="all">
        <div className="sechead">
          <h2>{q ? t("home.searchResults", { q }) : t("home.all")}</h2>
          {games.length > 1 && (
            <label className="sort-select">
              <span className="sr-only">{t("fb.sort.label")}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((v) => <option key={v} value={v}>{t(`home.sort.${v}`)}</option>)}
              </select>
            </label>
          )}
          {cats.length > 1 && (
            <div className="chips" role="group">
              <button type="button" className={cat === "all" ? "on" : ""} aria-pressed={cat === "all"} onClick={() => setCat("all")}>{t("home.allCategories")}</button>
              {cats.map((c) => (
                <button type="button" key={c} className={cat === c ? "on" : ""} aria-pressed={cat === c} onClick={() => setCat(c)}>{t(`cat.${c}`)}</button>
              ))}
            </div>
          )}
        </div>
        {shown.length ? (
          <GameGrid games={shown} />
        ) : (
          <div className="msg">
            <p>{t("home.noMatch")}</p>
            <Link to="/" className="btn">{t("home.showAll")}</Link>
          </div>
        )}
      </section>
    </>
  );
}

function Featured({ slides }: { slides: Game[] }) {
  const { t, lang } = useI18n();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const game = slides[i % slides.length];
  const ratios = useImageRatios(slides.map((s) => (s.banner_url ? null : s.thumbnail_url)));
  // Shape (width / height) of the cover shown in the banner. Pixel covers are 2:1.
  const ratio = (game.thumbnail_url && ratios[game.thumbnail_url]) || (game.thumbnail_url ? 4 / 3 : 2);

  useEffect(() => {
    if (slides.length < 2 || paused || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setTimeout(() => setI((n) => (n + 1) % slides.length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [i, paused, slides.length]);

  const desc = (lang === "de" && game.description_de) || game.description;
  return (
    <section
      // With a banner picture: the wide layout. Without: the cover keeps its own shape.
      className={`feature ${game.banner_url ? "" : "fitted"}`}
      style={{ "--r": ratio } as CSSProperties}
      aria-roledescription="carousel"
      aria-label={t("home.featured")}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      // On phones, swiping sideways shows the next or previous game.
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const from = touch.current;
        touch.current = null;
        if (!from || slides.length < 2) return;
        const dx = e.changedTouches[0].clientX - from.x;
        const dy = e.changedTouches[0].clientY - from.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) setI((n) => (n + (dx < 0 ? 1 : -1) + slides.length) % slides.length);
      }}
    >
      <Link to={`/game/${game.slug}`} className="feature-cover" tabIndex={-1} aria-hidden="true">
        {game.banner_url ? (
          <img key={game.id} className="cover" src={game.banner_url} alt="" decoding="async" />
        ) : (
          <Cover key={game.id} slug={game.slug} cover={game.cover} image={game.thumbnail_url} wide eager animate="always" />
        )}
      </Link>
      <div className="txt" key={game.id}>
        <span className="label">{game.featured ? t("home.featured") : t("home.popular")}</span>
        <h1>{game.title}</h1>
        {desc && <p>{desc}</p>}
        <span className="meta">
          <b>{game.author ? `@${game.author.username}` : "Toki"}</b>
          {game.engine ? ` · ${game.engine}` : ""} · {t(`cat.${game.category}`)}
          {plays(game) > 0 && <> · <Plays game={game} /></>}
        </span>
        <div className="actions">
          <Link to={`/game/${game.slug}`} className="btn primary"><PlayIcon />{t("game.play")}</Link>
          {slides.length > 1 && (
            <div className="dots" role="group" aria-label={t("home.pickFeatured")}>
              {slides.map((s, n) => (
                <button type="button" key={s.id} className={n === i ? "on" : ""} aria-pressed={n === i} aria-label={s.title} onClick={() => setI(n)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Width / height of each picture, once it has loaded (loaded ahead, so slides don't jump). */
function useImageRatios(urls: (string | null)[]) {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const key = urls.join("|");
  useEffect(() => {
    let alive = true;
    for (const url of key.split("|").filter(Boolean)) {
      const img = new Image();
      img.onload = () => alive && img.naturalHeight && setRatios((r) => ({ ...r, [url]: img.naturalWidth / img.naturalHeight }));
      img.src = url;
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return ratios;
}

const SUGGEST_KEY = "toki.suggest";
const SUGGEST_MS = 30 * 60_000;

/** "You might like": games the free AI picked from what the player liked and played. */
function Suggested({ games, recentSlugs }: { games: Game[]; recentSlugs: string[] }) {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const on = useFreeAi();
  const userId = session?.user.id ?? "";
  const [list, setList] = useState<Suggestion[]>([]);
  const recentKey = recentSlugs.slice(0, 10).join(",");

  useEffect(() => {
    if (!on || !userId) return setList([]);
    // Kept for a while in this tab, so going back to the home page doesn't ask again.
    const key = `${SUGGEST_KEY}.${userId}.${lang}`;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as { at: number; games: Suggestion[] } | null;
      if (saved && Date.now() - saved.at < SUGGEST_MS) return setList(saved.games);
    } catch {
      /* ask the server */
    }
    let alive = true;
    suggestions(lang, recentKey ? recentKey.split(",") : [])
      .then((g) => {
        if (!alive) return;
        setList(g);
        try {
          sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), games: g }));
        } catch {
          /* only a convenience */
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [on, userId, lang, recentKey]);

  const shown = list.map((s) => ({ s, g: games.find((g) => g.id === s.id) })).filter((x): x is { s: Suggestion; g: Game } => !!x.g);
  if (!shown.length) return null;
  return (
    <section aria-labelledby="suggest-h">
      <div className="sechead"><h2 id="suggest-h">{t("home.suggested")}</h2></div>
      <div className="grid">
        {shown.map(({ s, g }) => (
          <div key={g.id} className="suggest">
            <GameCard game={g} />
            {s.why && <p className="sub suggest-why">{s.why}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

// Asked at most once a minute, so going back and forth to the home page doesn't ask every time.
const FRIENDS_MS = 60_000;
let friendsCache: { user: string; at: number; rows: Promise<FriendRow[]> } | null = null;
function friendsNow(userId: string): Promise<FriendRow[]> {
  if (!friendsCache || friendsCache.user !== userId || Date.now() - friendsCache.at > FRIENDS_MS) {
    friendsCache = { user: userId, at: Date.now(), rows: myFriends() };
    friendsCache.rows.catch(() => (friendsCache = null));
  }
  return friendsCache.rows;
}

/** Friends who are playing something right now, with a link to join in. Only for logged-in players. */
function FriendsPlaying({ games }: { games: Game[] }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [rows, setRows] = useState<FriendRow[]>([]);

  useEffect(() => {
    if (!userId) return setRows([]);
    let alive = true;
    friendsNow(userId).then((r) => alive && setRows(r), () => {});
    return () => {
      alive = false;
    };
  }, [userId]);

  const playing = rows
    .filter((r) => r.status === "friend" && r.playing && isOnline(r.last_seen))
    .map((r) => ({ r, g: games.find((g) => g.id === r.playing) }))
    .filter((x): x is { r: FriendRow; g: Game } => !!x.g);
  if (!playing.length) return null;
  return (
    <section aria-labelledby="friends-playing-h">
      <div className="sechead"><h2 id="friends-playing-h">{t("home.friendsPlaying")}</h2></div>
      <div className="recent">
        {playing.map(({ r, g }) => (
          <Link key={r.id} to={`/game/${g.slug}`} className="ritem">
            <Avatar person={r} size={40} online />
            <span>
              <b>@{r.username}</b>
              <span className="sub">{t("soc.playingNow")} {g.title}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
