import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LogoMark, SearchIcon } from "./icons";

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { profile, signOut } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQ(params.get("q") ?? "");
  }, [params]);
  useEffect(() => {
    window.scrollTo(0, 0);
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
    navigate(v ? `/?q=${encodeURIComponent(v)}` : "/");
  };

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
          <nav className="navgroup" aria-label={t("nav.create")}>
            <h4>{t("nav.create")}</h4>
            <NavLink to="/my-games">{t("nav.myGames")}</NavLink>
            <NavLink to="/add">{t("nav.addGame")}</NavLink>
            {profile.role === "admin" && <NavLink to="/invites">{t("nav.invites")}</NavLink>}
          </nav>
        )}
        <div className="side-foot">
          {profile ? (
            <>
              <span className="who">@{profile.username}</span>
              <button type="button" className="linkish" onClick={() => signOut().then(() => navigate("/"))}>{t("nav.logout")}</button>
            </>
          ) : (
            <NavLink to="/login" className="linkish">{t("nav.login")}</NavLink>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <form className="search" role="search" onSubmit={onSearch}>
            <SearchIcon />
            <input ref={searchRef} id="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="spacer" />
          <div className="lang" role="group" aria-label="Language / Sprache">
            <button type="button" className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")}>EN</button>
            <button type="button" className={lang === "de" ? "on" : ""} aria-pressed={lang === "de"} onClick={() => setLang("de")}>DE</button>
          </div>
          {profile && (
            <Link to="/add" className="btn primary"><span aria-hidden="true">+</span>{t("nav.addGame")}</Link>
          )}
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
