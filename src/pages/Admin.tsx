import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { openApplicationCount } from "../lib/applications";
import { useTitle } from "../lib/useTitle";
import { saveIdeaBanner, useIdeaBanner } from "../lib/ideas";
import { dailySchedule, setDailyGame, utcDay, type DailyPlan } from "../lib/daily";
import { useGames } from "../lib/useGames";

// The admin pages, in one place, so the sidebar needs only one link for them.
const PAGES = [
  { to: "/applications", key: "applications" },
  { to: "/reports", key: "reports" },
  { to: "/invites", key: "invites" },
  { to: "/admin/ai", key: "ai" },
  { to: "/admin/hosting", key: "hosting" },
] as const;

/** Admins: an overview of the admin pages (/admin). */
export function Admin() {
  const { t } = useI18n();
  useTitle(t("nav.admin"));
  const [openApps, setOpenApps] = useState(0);
  useEffect(() => {
    let alive = true;
    openApplicationCount().then((n) => alive && setOpenApps(n));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="panel narrow">
      <h1 className="h">{t("nav.admin")}</h1>
      <p className="lead">{t("admin.lead")}</p>
      <ul className="admin-links">
        {PAGES.map((p) => (
          <li key={p.to}>
            <Link to={p.to}>
              <b>
                {t(`nav.${p.key}`)}
                {p.key === "applications" && openApps > 0 && <span className="count-pill">{openApps}</span>}
              </b>
              <span>{t(`admin.${p.key}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <IdeaBannerSwitch />
      <DailyPicker />
    </section>
  );
}

/** Shows or hides "Missing a game you want?" on the home page, for everyone. */
function IdeaBannerSwitch() {
  const { t } = useI18n();
  const shown = useIdeaBanner();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const change = async (on: boolean) => {
    setBusy(true);
    setErr(false);
    try {
      await saveIdeaBanner(on);
    } catch {
      setErr(true);
    }
    setBusy(false);
  };
  return (
    <div className="admin-setting">
      <h2>{t("admin.home")}</h2>
      <label className="check">
        <input type="checkbox" checked={shown === true} disabled={busy || shown === null} onChange={(e) => change(e.target.checked)} />
        <span>
          {t("admin.ideaBanner")}
          <span className="sub">{t("admin.ideaBannerHelp")}</span>
        </span>
      </label>
      {err && <p className="error" role="alert">{t("error")}</p>}
    </div>
  );
}

/** Today's game is picked by itself; admins can choose the game for a day instead. */
function DailyPicker() {
  const { t, lang } = useI18n();
  const { games } = useGames();
  const today = utcDay(new Date());
  const last = utcDay(new Date(Date.now() + 60 * 86_400_000));
  const [plan, setPlan] = useState<DailyPlan[] | null>(null);
  const [day, setDay] = useState(today);
  const [gameId, setGameId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    dailySchedule().then((p) => alive && setPlan(p), () => alive && setPlan([]));
    return () => {
      alive = false;
    };
  }, [reload]);

  const title = (id: string) => games?.find((g) => g.id === id)?.title ?? "…";
  const dateText = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(lang === "de" ? "de-CH" : "en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(false);
    try {
      await setDailyGame(day, gameId || null);
      setReload((n) => n + 1);
    } catch {
      setErr(true);
    }
    setBusy(false);
  };

  return (
    <div className="admin-setting">
      <h2>{t("daily.label")}</h2>
      <p className="sub">{t("daily.admin.help")}</p>
      {plan && plan.length > 0 && (
        <ul className="daily-plan">
          {plan.map((p) => (
            <li key={p.day}>
              <b>{p.day === today ? t("daily.tab") : dateText(p.day)}</b> {title(p.game_id)}{" "}
              <span className="sub">{p.chosen ? t("daily.admin.chosen") : t("daily.admin.picked")}</span>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={save}>
        <label htmlFor="daily-day">{t("daily.admin.day")}</label>
        <input id="daily-day" type="date" min={today} max={last} value={day} required onChange={(e) => setDay(e.target.value)} />
        <label htmlFor="daily-game">{t("daily.admin.game")}</label>
        <select id="daily-game" value={gameId} onChange={(e) => setGameId(e.target.value)}>
          <option value="">{t("daily.admin.auto")}</option>
          {[...(games ?? [])].sort((a, b) => a.title.localeCompare(b.title)).map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={busy || !day}>{t("daily.admin.save")}</button>
      </form>
      {err && <p className="error" role="alert">{t("error")}</p>}
    </div>
  );
}
