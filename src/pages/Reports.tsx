import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { handleReport, listReports, type Report } from "../lib/social";
import { Avatar } from "../components/Avatar";
import { useTitle } from "../lib/useTitle";

/** Admins: reported chat messages. */
export function Reports() {
  const { t, lang } = useI18n();
  useTitle(t("nav.reports"));
  const [open, setOpen] = useState(true);
  const [list, setList] = useState<Report[] | null>(null);
  const [days, setDays] = useState(7);
  const [err, setErr] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setList(null);
    listReports(open).then((r) => alive && setList(r), () => alive && setErr(t("error")));
    return () => {
      alive = false;
    };
  }, [open, reload, t]);

  const act = async (r: Report, outcome: "dismissed" | "deleted" | "banned") => {
    setErr("");
    try {
      await handleReport(r.id, outcome, outcome === "banned" ? days : 0);
      setReload((n) => n + 1);
    } catch {
      setErr(t("error"));
    }
  };

  return (
    <section className="panel reports">
      <div className="sechead">
        <h1 className="h">{t("nav.reports")}</h1>
        <div className="chips" role="group">
          <button type="button" className={open ? "on" : ""} aria-pressed={open} onClick={() => setOpen(true)}>{t("rep.open")}</button>
          <button type="button" className={!open ? "on" : ""} aria-pressed={!open} onClick={() => setOpen(false)}>{t("rep.handled")}</button>
        </div>
      </div>
      <p className="lead">{t("rep.help")}</p>
      {open && !!list?.length && (
        <label className="inline-form">
          {t("rep.banFor")}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 365].map((d) => <option key={d} value={d}>{t("rep.days", { n: d })}</option>)}
          </select>
        </label>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {list === null ? <p className="msg">{t("loading")}</p> : list.length === 0 ? <p className="msg">{t("rep.none")}</p> : (
        <ul className="report-list">
          {list.map((r) => (
            <li key={r.id}>
              <div className="msg-head">
                {r.author ? <Link to={`/u/${r.author.username}`} className="person"><Avatar person={r.author} size={24} /><b>@{r.author.username}</b></Link> : <b>?</b>}
                <time className="sub">{ago(r.created_at, lang)}</time>
              </div>
              <blockquote>{r.body}</blockquote>
              <p className="sub">
                {t("rep.by", { who: r.reporter ? `@${r.reporter.username}` : "?" })}
                {r.reason && <> · {lang === "de" ? `„${r.reason}“` : `“${r.reason}”`}</>}
                {r.chat_id && <> · <Link to={`/chat/${r.chat_id}`}>{t("rep.openChat")}</Link></>}
              </p>
              {open ? (
                <div className="actions">
                  <button type="button" className="btn" onClick={() => act(r, "dismissed")}>{t("rep.dismiss")}</button>
                  <button type="button" className="btn" onClick={() => act(r, "deleted")} disabled={!r.message_id}>{t("rep.delete")}</button>
                  <button type="button" className="btn danger" onClick={() => act(r, "banned")}>{t("rep.ban", { n: days })}</button>
                </div>
              ) : (
                <p className="sub">{t(`rep.outcome.${r.outcome ?? "dismissed"}`)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
