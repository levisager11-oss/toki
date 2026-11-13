import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { handleReport, listReports, type Report } from "../lib/social";
import { handleContentReport, listContentReports, REPORT_NOTE_MAX, type ContentReport } from "../lib/account";
import { Avatar } from "../components/Avatar";
import { assistError, checkReports, useAiFeature } from "../lib/assist";
import { nextTermsApply } from "../lib/terms";
import { useTitle } from "../lib/useTitle";

/** Admins: reported chat messages, and reported games, profiles, feedback posts and ideas. */
export function Reports() {
  const { t, lang } = useI18n();
  useTitle(t("nav.reports"));
  const [open, setOpen] = useState(true);
  const [list, setList] = useState<Report[] | null>(null);
  const [other, setOther] = useState<ContentReport[] | null>(null);
  // The reason the owner is told, per report.
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [days, setDays] = useState(7);
  const [err, setErr] = useState("");
  const [reload, setReload] = useState(0);
  // The AI's first look at open reports (an admin still decides).
  // Only from the day the terms allow it (src/lib/terms.ts).
  const aiOn = useAiFeature("moderate") && nextTermsApply();
  const [checking, setChecking] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const unchecked = (list ?? []).some((r) => !r.ai_verdict) || (other ?? []).some((r) => !r.ai_verdict);
  const askAi = async () => {
    setChecking(true);
    setAiMsg("");
    try {
      // A few reports per call, until every open one has a first look.
      for (let i = 0; i < 10; i++) {
        const r = await checkReports(lang);
        if (!r.more || !r.checked) break;
      }
      setReload((n) => n + 1);
    } catch (e) {
      setAiMsg(t(`assist.err.${assistError(e)}`));
    }
    setChecking(false);
  };

  useEffect(() => {
    let alive = true;
    setList(null);
    setOther(null);
    listReports(open).then((r) => alive && setList(r), () => alive && setErr(t("error")));
    listContentReports(open).then((r) => alive && setOther(r), () => alive && setErr(t("error")));
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

  const actOther = async (r: ContentReport, outcome: "dismissed" | "removed" | "banned") => {
    setErr("");
    try {
      await handleContentReport(r.id, outcome, notes[r.id]?.trim() ?? "", outcome === "banned" ? days : 0);
      setReload((n) => n + 1);
    } catch {
      setErr(t("error"));
    }
  };
  // Where the reported thing is. Ideas and feedback posts open by their id; games and profiles by name.
  const where = (r: ContentReport) =>
    r.kind === "feedback" ? `/feedback/${r.target}` : r.kind === "idea" ? `/ideas/${r.target}` : r.kind === "profile" && r.owner ? `/u/${r.owner.username}` : null;

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
      {open && (!!list?.length || !!other?.length) && (
        <label className="inline-form">
          {t("rep.banFor")}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 365].map((d) => <option key={d} value={d}>{t("rep.days", { n: d })}</option>)}
          </select>
        </label>
      )}
      {open && aiOn && unchecked && (
        <div className="setup-row">
          <button type="button" className="btn" onClick={askAi} disabled={checking}>{checking ? t("rep.ai.checking") : t("rep.ai.check")}</button>
          <small>{t("rep.ai.help")}</small>
        </div>
      )}
      {aiMsg && <p className="error" role="alert">{aiMsg}</p>}
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
              <AiVerdict verdict={r.ai_verdict} reason={r.ai_reason} />
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

      <div className="sechead"><h2>{t("rep.other.title")}</h2></div>
      <p className="lead">{t("rep.other.help")}</p>
      {other === null ? <p className="msg">{t("loading")}</p> : other.length === 0 ? <p className="msg">{t("rep.none")}</p> : (
        <ul className="report-list">
          {other.map((r) => (
            <li key={r.id}>
              <div className="msg-head">
                <b>{t(`mod.what.${r.kind}`)}: {where(r) ? <Link to={where(r)!}>{r.title}</Link> : r.title}</b>
                <span className="st st-planned">{t(`report.cat.${r.category}`)}</span>
                <time className="sub">{ago(r.created_at, lang)}</time>
              </div>
              {r.reason && <blockquote>{r.reason}</blockquote>}
              <AiVerdict verdict={r.ai_verdict} reason={r.ai_reason} />
              <p className="sub">
                {t("rep.by", { who: r.reporter ? `@${r.reporter.username}` : "?" })}
                {r.owner && <> · {t("rep.other.owner")} <Link to={`/u/${r.owner.username}`}>@{r.owner.username}</Link></>}
              </p>
              {open ? (
                <>
                  <input
                    maxLength={REPORT_NOTE_MAX}
                    value={notes[r.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                    placeholder={t("rep.other.note")}
                    aria-label={t("rep.other.note")}
                  />
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => actOther(r, "dismissed")}>{t("rep.dismiss")}</button>
                    <button type="button" className="btn danger" onClick={() => actOther(r, "removed")}>{t(`rep.other.remove.${r.kind}`)}</button>
                    <button type="button" className="btn danger" onClick={() => actOther(r, "banned")} disabled={!r.owner}>{t("rep.other.removeBan", { n: days })}</button>
                  </div>
                </>
              ) : (
                <p className="sub">{t(`rep.other.outcome.${r.outcome ?? "dismissed"}`)}{r.note && <> · {lang === "de" ? `„${r.note}“` : `“${r.note}”`}</>}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The AI's first look at a report, if there is one. */
function AiVerdict({ verdict, reason }: { verdict?: "remove" | "keep" | "unsure" | null; reason?: string | null }) {
  const { t } = useI18n();
  if (!verdict) return null;
  return (
    <p className={`check ${verdict === "remove" ? "warn" : verdict === "keep" ? "good" : ""} ai-verdict`}>
      <b>{t(`rep.ai.verdict.${verdict}`)}</b>
      {reason && <> · {reason}</>} <small className="sub">({t("rep.ai.note")})</small>
    </p>
  );
}
