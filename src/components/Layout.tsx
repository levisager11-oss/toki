import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canCreate } from "../lib/types";
import { matchIsolation, pageIsolated } from "../lib/isolation";
import { useBottomBarFix } from "../lib/useBottomBarFix";
import { APPLICATIONS_CHANGED, openApplicationCount } from "../lib/applications";
import { BellIcon, BubbleIcon, HeartTabIcon, HomeIcon, KeyIcon, ListIcon, LogoMark, LogoutIcon, PlusIcon, SearchIcon, UserIcon } from "./icons";
import { useBadges } from "../lib/useBadges";
import { setTitleCount } from "../lib/useTitle";
import { useNewUpdate } from "../lib/whatsNew";
import { Avatar } from "./Avatar";
import { useAiStatus } from "../lib/assist";
import { ErrorBoundary } from "./ErrorBoundary";
import { InvitePopup } from "./GameInvite";
import { PartyBar } from "./Party";
import { AgeGate } from "./AgeGate";
import { keepPush } from "../lib/push";
import { LEVEL_UP, refreshProgress, useMyProgress } from "../lib/cosmetics";
import { levelProgress } from "../lib/progress";
import { LevelBadge, TokenCoin, Tokens } from "./Looks";

// The admin pages, all reached through "Admin" in the sidebar.
const ADMIN_PAGE = /^\/(admin|applications|invites|reports)(\/|$)/;

// The developer pages, folded into "Create" in the sidebar.
const CREATE_PAGE = /^\/(my-games|add|edit|feedback\/inbox|ideas|connect|admin|applications|invites|reports|game\/[^/]+\/stats)(\/|$)/;
// The shop and what belongs to it.
const SHOP_PAGE = /^\/(shop|trades)(\/|$)/;

function ChevronIcon() {
  return (
    <svg className="chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" shapeRendering="crispEdges">
      <path d="M2 3h1v1h1v1h2v-1h1v-1h1v2h-1v1h-1v1h-2v-1h-1v-1h-1z" fill="currentColor" />
    </svg>
  );
}

/** Whether the sidebar's "Create" is open: on a developer page always, else as the player left it. */
function useCreateOpen(path: string): [boolean, (open: boolean) => void] {
  const [saved, setSaved] = useState(() => {
    try {
      return localStorage.getItem("toki.side.create") === "1";
    } catch {
      return false;
    }
  });
  const [closedHere, setClosedHere] = useState(false);
  useEffect(() => setClosedHere(false), [path]);
  const onPage = CREATE_PAGE.test(path);
  const set = (open: boolean) => {
    setSaved(open);
    setClosedHere(!open);
    try {
      localStorage.setItem("toki.side.create", open ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return [(saved || onPage) && !closedHere, set];
}

// A game's own page, not e.g. its feedback board.
const GAME_PAGE = /^\/game\/[^/]+\/?$/;

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { profile, signOut } = useAuth();
  const badges = useBadges();
  const newUpdate = useNewUpdate();
  const offline = useOffline();
  const unread = profile ? badges.notifications + badges.chats : 0;
  useEffect(() => setTitleCount(unread), [unread]);
  const ai = useAiStatus();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const searchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  useBottomBarFix(tabbarRef);
  useBarHeights(topRef, tabbarRef);
  // A device with invite notifications on keeps getting them, for whoever is logged in.
  const myId = profile?.id;
  useEffect(() => {
    if (myId) keepPush(myId, lang).catch(() => {});
  }, [myId, lang]);
  // A tapped notification, while Toki is open: go to its page (public/sw.js).
  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { toki?: string; url?: unknown } | null;
      if (m?.toki === "open" && typeof m.url === "string" && /^\/(?![/\\])/.test(m.url)) navigate(m.url);
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [navigate]);
  // Admins: how many applications for developer accounts wait, shown next to "Applications".
  const [openApps, setOpenApps] = useState(0);
  const isAdmin = profile?.role === "admin";
  const [createOpen, setCreate] = useCreateOpen(location.pathname);
  useEffect(() => {
    if (!isAdmin) return setOpenApps(0);
    let alive = true;
    const load = () => openApplicationCount().then((n) => alive && setOpenApps(n));
    load();
    window.addEventListener(APPLICATIONS_CHANGED, load);
    return () => {
      alive = false;
      window.removeEventListener(APPLICATIONS_CHANGED, load);
    };
  }, [isAdmin, location.pathname]);

  useEffect(() => {
    // Keeps what is being typed (e.g. a space at the end) when it's the same search.
    const p = params.get("q") ?? "";
    setQ((cur) => (cur.trim() === p ? cur : p));
  }, [params]);
  useEffect(() => {
    if (!location.hash) {
      // Back and forward: leave the browser to go back to where the visitor was.
      if (navType !== "POP") window.scrollTo(0, 0);
      return;
    }
    // A link to a part of a page (e.g. a game's high scores): wait for it to load, then go there.
    let tries = 0;
    const id = setInterval(() => {
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) el.scrollIntoView({ block: "start" });
      if (el || ++tries > 30) clearInterval(id);
    }, 150);
    return () => clearInterval(id);
    // Only a new page counts, not e.g. the search text changing on the home page (navType
    // is read for the change that led here).
  }, [location.pathname, location.hash]);
  // Level and tokens: asked again now and then while moving around Toki (at most every 20 s).
  const progress = useMyProgress(myId);
  useEffect(() => {
    if (myId) void refreshProgress(myId);
  }, [myId, location.pathname]);
  const lv = progress ? levelProgress(progress.xp) : null;
  useEffect(() => {
    // Only game pages can be isolated (the game page checks its own game).
    if (pageIsolated() && !GAME_PAGE.test(location.pathname)) matchIsolation(false);
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // On the home page the list filters while typing; elsewhere the search starts on Enter.
  const onType = (v: string) => {
    setQ(v);
    if (location.pathname !== "/") return;
    const next = v.trim();
    if (next === (params.get("q") ?? "")) return;
    // Keeps the chosen category.
    const p = new URLSearchParams(params);
    if (next) p.set("q", next);
    else p.delete("q");
    const query = p.toString();
    navigate(query ? `/?${query}` : "/", { replace: true });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    searchRef.current?.blur(); // closes the phone keyboard
    if (location.pathname === "/") return; // already shown while typing
    navigate(v ? `/?q=${encodeURIComponent(v)}` : "/");
  };

  const langSwitch = (
    <div className="lang" role="group" aria-label="Language / Sprache">
      <button type="button" className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")}>EN</button>
      <button type="button" className={lang === "de" ? "on" : ""} aria-pressed={lang === "de"} onClick={() => setLang("de")}>DE</button>
    </div>
  );

  return (
    <div className="app">
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        {t("nav.skip")}
      </a>
      <aside className="side">
        <Link to="/" className="logo"><LogoMark />toki</Link>
        <nav className="navgroup" aria-label={t("nav.play")}>
          <h4>{t("nav.play")}</h4>
          <NavLink to="/" end>{t("nav.discover")}</NavLink>
          <NavLink to="/favorites">{t("nav.favorites")}</NavLink>
          <NavLink to="/top">{t("nav.top")}</NavLink>
          <NavLink to="/shop" className={() => (SHOP_PAGE.test(location.pathname) ? "active" : "")}>{t("nav.shop")}</NavLink>
        </nav>
        {profile && (
          // Notifications are the bell in the top bar; trades are in the shop.
          <nav className="navgroup" aria-label={t("nav.social")}>
            <h4>{t("nav.social")}</h4>
            <NavLink to="/chat">{t("nav.chat")}{badges.chats > 0 && <span className="count-pill">{badges.chats}</span>}</NavLink>
            <NavLink to="/friends">{t("nav.friends")}</NavLink>
            <NavLink to="/feed">{t("nav.feed")}</NavLink>
          </nav>
        )}
        {canCreate(profile) && profile && (
          // The developer pages fold away; "Add game" is the button in the top bar.
          <nav className="navgroup" aria-label={t("nav.create")}>
            <button type="button" className={`navgroup-toggle${createOpen ? " open" : ""}`} aria-expanded={createOpen} onClick={() => setCreate(!createOpen)}>
              <span className="navgroup-title">{t("nav.create")}</span>
              {!createOpen && openApps > 0 && <span className="count-pill">{openApps}</span>}
              <ChevronIcon />
            </button>
            {createOpen && (
              <>
                <NavLink to="/my-games">{t("nav.myGames")}</NavLink>
                <NavLink to="/feedback/inbox">{t("fb.inbox.title")}</NavLink>
                <NavLink to="/ideas">{t("idea.title")}</NavLink>
                <NavLink to="/docs">{t("nav.docs")}</NavLink>
                {(ai.strong || ai.free) && <NavLink to="/connect">{t("nav.connect")}</NavLink>}
                {profile.role === "admin" && (
                  <NavLink to="/admin" className={() => (ADMIN_PAGE.test(location.pathname) ? "active" : "")}>
                    {t("nav.admin")}
                    {openApps > 0 && <span className="count-pill">{openApps}</span>}
                  </NavLink>
                )}
              </>
            )}
          </nav>
        )}
        <div className="side-foot">
          <nav className="navgroup" aria-label="Toki">
            <div className="navgroup-head">
              <h4>Toki</h4>
              <span className="side-legal">
                <Link to="/terms">{t("nav.terms")}</Link>
                <Link to="/privacy">{t("nav.privacy")}</Link>
                <Link to="/imprint">{t("nav.imprint")}</Link>
              </span>
            </div>
            <NavLink to="/updates">{t("rel.whatsNew")}{newUpdate && <span className="new-dot" title={t("rel.newSinceVisit")}><span className="sr-only">{t("rel.newSinceVisit")}</span></span>}</NavLink>
            <NavLink to="/feedback" end>{t("nav.feedback")}</NavLink>
            {profile && !canCreate(profile) && <NavLink to="/ideas">{t("idea.mine")}</NavLink>}
          </nav>
          {profile && lv && (
            <Link to="/shop" className="me-level" title={t("lv.toNext", { n: lv.needed - lv.into })}>
              <LevelBadge level={lv.level} />
              <span className="lv-bar small" aria-hidden="true"><i style={{ width: `${lv.share * 100}%` }} /></span>
              <Tokens n={progress?.tokens} />
            </Link>
          )}
          {profile ? (
            <div className="me">
              <NavLink to="/account" className="me-link">
                <Avatar person={profile} size={32} />
                <span className="me-txt">
                  <b>@{profile.username}</b>
                  <span>{t(`role.${profile.role}`)}</span>
                </span>
              </NavLink>
              <button type="button" className="me-out" aria-label={t("nav.logout")} title={t("nav.logout")} onClick={() => signOut().then(() => navigate("/"))}>
                <LogoutIcon />
              </button>
            </div>
          ) : (
            <div className="me-guest">
              <NavLink to="/login" className="btn">{t("nav.login")}</NavLink>
              <Link to="/signup" className="linkish">{t("login.signup")}</Link>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="top" ref={topRef}>
          <Link to="/" className="logo mobile-only"><LogoMark />toki</Link>
          <form className="search" role="search" onSubmit={onSearch}>
            <SearchIcon />
            <input ref={searchRef} id="search" type="search" enterKeyHint="search" value={q} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => e.key === "Escape" && q && (e.preventDefault(), onType(""))} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="spacer" />
          {profile && (
            <>
              <NavLink to="/chat" className="icon-btn" aria-label={`${t("nav.chat")}${badges.chats ? ` (${t("chat.unread", { n: badges.chats })})` : ""}`} title={t("nav.chat")}>
                <BubbleIcon />{badges.chats > 0 && <span className="count-pill">{badges.chats > 9 ? "9+" : badges.chats}</span>}
              </NavLink>
              <NavLink to="/notifications" className="icon-btn" aria-label={`${t("nav.notifications")}${badges.notifications ? ` (${badges.notifications})` : ""}`} title={t("nav.notifications")}>
                <BellIcon />{badges.notifications > 0 && <span className="count-pill">{badges.notifications > 9 ? "9+" : badges.notifications}</span>}
              </NavLink>
            </>
          )}
          {langSwitch}
          {canCreate(profile) && (
            <Link to="/add" className="btn primary desktop-only"><span aria-hidden="true">+</span>{t("nav.addGame")}</Link>
          )}

        </header>
        {offline && <p className="offline-bar" role="status">{t("offline")}</p>}
        {profile && <PartyBar me={profile.id} />}
        <AgeGate />
        <main className="content" id="main" tabIndex={-1}>
          {/* A new boundary per page, so going to another page clears an error. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
          <footer className="foot mobile-only">
            <Link to="/updates">{t("nav.updates")}{newUpdate && <span className="new-dot" title={t("rel.newSinceVisit")}><span className="sr-only">{t("rel.newSinceVisit")}</span></span>}</Link>
            <Link to="/feedback">{t("nav.tokiFeedback")}</Link>
            {profile && <Link to="/ideas">{t(canCreate(profile) ? "idea.title" : "idea.mine")}</Link>}
            <Link to="/terms">{t("nav.terms")}</Link>
            <Link to="/privacy">{t("nav.privacy")}</Link>
            <Link to="/imprint">{t("nav.imprint")}</Link>
          </footer>
        </main>
      </div>

      {profile && <InvitePopup />}
      {profile && <LevelUpToast />}

      <nav ref={tabbarRef} className="tabbar" aria-label="Toki">
        <NavLink to="/" end><HomeIcon /><span>{t("nav.discover")}</span></NavLink>
        <NavLink to="/favorites"><HeartTabIcon /><span>{t("nav.favorites")}</span></NavLink>
        {profile ? (
          <>
            {canCreate(profile) && (
              <>
                <NavLink to="/my-games"><ListIcon /><span>{t("nav.myGames")}</span></NavLink>
                <NavLink to="/add"><PlusIcon /><span>{t("nav.addGameTab")}</span></NavLink>
              </>
            )}
            {profile.role === "admin" && (
              <NavLink to="/admin" className={() => (ADMIN_PAGE.test(location.pathname) ? "active" : "")}><KeyIcon /><span>{t("nav.admin")}</span></NavLink>
            )}
            <NavLink to="/account"><UserIcon /><span>{t("nav.account")}</span></NavLink>
          </>
        ) : (
          <NavLink to="/login"><KeyIcon /><span>{t("nav.login")}</span></NavLink>
        )}
      </nav>
    </div>
  );
}

/** "Level 5!" for a moment, when the player reaches a new level while Toki is open. */
function LevelUpToast() {
  const { t } = useI18n();
  const [up, setUp] = useState<{ level: number; tokens: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setUp((e as CustomEvent<{ level: number; tokens: number }>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setUp(null), 7000);
    };
    window.addEventListener(LEVEL_UP, on);
    return () => {
      window.removeEventListener(LEVEL_UP, on);
      clearTimeout(timer);
    };
  }, []);
  if (!up) return null;
  return (
    <div className="levelup" role="status">
      <LevelBadge level={up.level} big />
      <span>
        <b>{t("lv.up", { n: up.level })}</b>
        <span className="sub"><TokenCoin /> {t("lv.upTokens", { n: up.tokens })}</span>
      </span>
      <Link to="/shop" className="btn small" onClick={() => setUp(null)}>{t("nav.shop")}</Link>
      <button type="button" className="linkish" aria-label={t("lv.close")} onClick={() => setUp(null)}>×</button>
    </div>
  );
}

/**
 * Keeps the heights of the top bar and the phone tab bar in --top-h and --tabbar-h (0 when
 * hidden), so a page like the chat can fill exactly the space between them.
 */
function useBarHeights(top: RefObject<HTMLElement | null>, bar: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = document.documentElement.style;
    const update = () => {
      root.setProperty("--top-h", `${top.current?.offsetHeight ?? 0}px`);
      root.setProperty("--tabbar-h", `${bar.current?.offsetHeight ?? 0}px`);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    if (top.current) ro.observe(top.current);
    if (bar.current) ro.observe(bar.current);
    return () => ro.disconnect();
  }, [top, bar]);
}

/** true while the browser has no internet connection. */
function useOffline() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline;
}
