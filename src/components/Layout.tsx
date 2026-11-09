import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { canCreate } from "../lib/types";
import { matchIsolation, pageIsolated } from "../lib/isolation";
import { useBottomBarFix } from "../lib/useBottomBarFix";
import { HeartTabIcon, HomeIcon, KeyIcon, ListIcon, LogoMark, LogoutIcon, PlusIcon, SearchIcon, UserIcon } from "./icons";

// A game's own page, not e.g. its feedback board.
const GAME_PAGE = /^\/game\/[^/]+\/?$/;

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { profile, signOut } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLElement>(null);
  useBottomBarFix(tabbarRef);

  useEffect(() => {
    setQ(params.get("q") ?? "");
  }, [params]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
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

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    searchRef.current?.blur(); // closes the phone keyboard
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
        {canCreate(profile) && profile && (
          <nav className="navgroup" aria-label={t("nav.create")}>
            <h4>{t("nav.create")}</h4>
            <NavLink to="/my-games">{t("nav.myGames")}</NavLink>
            <NavLink to="/add">{t("nav.addGame")}</NavLink>
            <NavLink to="/feedback/inbox">{t("fb.inbox.title")}</NavLink>
            {profile.role === "admin" && <NavLink to="/invites">{t("nav.invites")}</NavLink>}
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
                <span className="avatar" aria-hidden="true">{profile.username.charAt(0)}</span>
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
            <input ref={searchRef} id="search" type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="spacer" />
          {langSwitch}
          {canCreate(profile) && (
            <Link to="/add" className="btn primary desktop-only"><span aria-hidden="true">+</span>{t("nav.addGame")}</Link>
          )}

        </header>
        <main className="content">
          <Outlet />
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
            {profile.role === "admin" && <NavLink to="/invites"><KeyIcon /><span>{t("nav.invites")}</span></NavLink>}
            <NavLink to="/account"><UserIcon /><span>{t("nav.account")}</span></NavLink>
          </>
        ) : (
          <NavLink to="/login"><KeyIcon /><span>{t("nav.login")}</span></NavLink>
        )}
      </nav>
    </div>
  );
}
