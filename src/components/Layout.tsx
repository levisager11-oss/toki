import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { Avatar } from "./Avatar";
import { useAiStatus } from "../lib/assist";
import { ErrorBoundary } from "./ErrorBoundary";

// The admin pages, all reached through "Admin" in the sidebar.
const ADMIN_PAGE = /^\/(admin|applications|invites|reports)(\/|$)/;

// A game's own page, not e.g. its feedback board.
const GAME_PAGE = /^\/game\/[^/]+\/?$/;

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { profile, signOut } = useAuth();
  const badges = useBadges();
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
  useBottomBarFix(tabbarRef);
  // Admins: how many applications for developer accounts wait, shown next to "Applications".
  const [openApps, setOpenApps] = useState(0);
  const isAdmin = profile?.role === "admin";
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
    // Only a new page counts, not e.g. the search text changing on the home page.
  }, [location.pathname, location.hash]);
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
      <aside className="side">
        <Link to="/" className="logo"><LogoMark />toki</Link>
        <nav className="navgroup" aria-label={t("nav.play")}>
          <h4>{t("nav.play")}</h4>
          <NavLink to="/" end>{t("nav.discover")}</NavLink>
          <NavLink to="/favorites">{t("nav.favorites")}</NavLink>
        </nav>
        {profile && (
          <nav className="navgroup" aria-label={t("nav.social")}>
            <h4>{t("nav.social")}</h4>
            <NavLink to="/chat">{t("nav.chat")}{badges.chats > 0 && <span className="count-pill">{badges.chats}</span>}</NavLink>
            <NavLink to="/friends">{t("nav.friends")}</NavLink>
            <NavLink to="/notifications">{t("nav.notifications")}{badges.notifications > 0 && <span className="count-pill">{badges.notifications}</span>}</NavLink>
          </nav>
        )}
        {canCreate(profile) && profile && (
          <nav className="navgroup" aria-label={t("nav.create")}>
            <h4>{t("nav.create")}</h4>
            <NavLink to="/my-games">{t("nav.myGames")}</NavLink>
            <NavLink to="/add">{t("nav.addGame")}</NavLink>
            <NavLink to="/feedback/inbox">{t("fb.inbox.title")}</NavLink>
            {(ai.strong || ai.free) && <NavLink to="/connect">{t("nav.connect")}</NavLink>}
            {profile.role === "admin" && (
              <NavLink to="/admin" className={() => (ADMIN_PAGE.test(location.pathname) ? "active" : "")}>
                {t("nav.admin")}
                {openApps > 0 && <span className="count-pill">{openApps}</span>}
              </NavLink>
            )}
          </nav>
        )}
        <div className="side-foot">
          <nav className="navgroup" aria-label="Toki">
            <h4>Toki</h4>
            <NavLink to="/updates">{t("rel.whatsNew")}</NavLink>
            <NavLink to="/feedback" end>{t("nav.feedback")}</NavLink>
          </nav>
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
        <header className="top">
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
        <main className="content">
          {/* A new boundary per page, so going to another page clears an error. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
          <footer className="foot mobile-only">
            <Link to="/updates">{t("nav.updates")}</Link>
            <Link to="/feedback">{t("nav.tokiFeedback")}</Link>
          </footer>
        </main>
      </div>

      <nav ref={tabbarRef} className="tabbar" aria-label="Toki">
        <NavLink to="/" end><HomeIcon /><span>{t("nav.discover")}</span></NavLink>
        <NavLink to="/favorites"><HeartTabIcon /><span>{t("nav.favorites")}</span></NavLink>
        {profile ? (
          <>
            {canCreate(profile) && (
              <>
                <NavLink to="/my-games"><ListIcon /><span>{t("nav.myGames")}</span></NavLink>
                <NavLink to="/add"><PlusIcon /><span>{t("nav.addGame")}</span></NavLink>
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
