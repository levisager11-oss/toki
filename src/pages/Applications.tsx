import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import {
  APPLICATIONS_CHANGED, developers, linkParts, openApplications, reviewApplication, setDeveloper, type Application,
} from "../lib/applications";

/** Admins: open applications for developer accounts, and who is a developer (/applications). */
export function Applications() {
  const { t } = useI18n();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [devs, setDevs] = useState<{ id: string; username: string }[] | null>(null);
  const [error, setError] = useState(false);
  const [done, setDone] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);

  const loadDevs = () => developers().then(setDevs).catch(() => setDevs([]));
  useEffect(() => {
    openApplications().then(setApps).catch(() => setError(true));
    loadDevs();
  }, []);

  const decided = (a: Application, approved: boolean) => {
    setApps((list) => list?.filter((x) => x.id !== a.id) ?? null);
    setDone(t(approved ? "apps.approved" : "apps.declined", { name: a.applicant?.username ?? "?" }));
    if (approved) loadDevs();
    window.dispatchEvent(new Event(APPLICATIONS_CHANGED));
  };
  const removeDev = async (id: string) => {
    try {
      await setDeveloper(id, false);
      setConfirm(null);
      loadDevs();
    } catch {
      setError(true);
    }
  };

  if (error) return <p className="msg">{t("error")}</p>;
  return (
    <section className="fb-board">
      <h1 className="h">{t("apps.title")}</h1>
      <p className="lead">{t("apps.lead")}</p>
      {done && <p className="check good" role="status">{done}</p>}
      {!apps ? (
        <p className="msg" aria-busy="true">{t("loading")}</p>
      ) : apps.length === 0 ? (
        <p className="msg fb-empty">{t("apps.empty")}</p>
      ) : (
        <div className="rv-list">{apps.map((a) => <ApplicationCard key={a.id} app={a} onDone={(ok) => decided(a, ok)} />)}</div>
      )}

      <section className="rv-trusted" aria-labelledby="devs-h">
        <h2 id="devs-h">{t("apps.developers")}</h2>
        <p className="hint">{t("apps.developersHelp")}</p>
        {devs && devs.length === 0 && <p className="hint">{t("apps.noDevelopers")}</p>}
        {devs && devs.length > 0 && (
          <ul>
            {devs.map((d) => (
              <li key={d.id}>
                <b>@{d.username}</b>
                {confirm === d.id ? (
                  <span className="actions">
                    <button type="button" className="btn danger" onClick={() => removeDev(d.id)}>{t("apps.removeConfirm")}</button>
                    <button type="button" className="btn" onClick={() => setConfirm(null)}>{t("form.cancel")}</button>
                  </span>
                ) : (
                  <button type="button" className="btn ghost-danger" onClick={() => setConfirm(d.id)}>{t("apps.remove")}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function Linked({ text }: { text: string }) {
  return (
    <p className="fb-body">
      {linkParts(text).map((p, i) => (p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a> : <span key={i}>{p.text}</span>))}
    </p>
  );
}

function ApplicationCard({ app, onDone }: { app: Application; onDone: (approved: boolean) => void }) {
  const { t, lang } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(false);
    try {
      await reviewApplication(app.id, approve, note);
      onDone(approve);
    } catch {
      setErr(true);
      setBusy(false);
    }
  };
  return (
    <article className="rv">
      <div className="rv-info">
        <b className="fb-title">@{app.applicant?.username ?? "?"}</b>
        <span className="sub">{t("apply.sent", { when: ago(app.created_at, lang) })}</span>
      </div>
      <div>
        <h3 className="label">{t("apply.about")}</h3>
        <Linked text={app.about} />
      </div>
      {app.links && (
        <div>
          <h3 className="label">{t("apply.links")}</h3>
          <Linked text={app.links} />
        </div>
      )}
      <div className="form rv-decide">
        <label htmlFor={`note-${app.id}`}>{t("apps.note")}</label>
        <textarea id={`note-${app.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("apps.notePlaceholder")} />
        {err && <p className="error" role="alert">{t("error")}</p>}
        <div className="actions fb-form-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => decide(true)}>{t("apps.approve")}</button>
          <button type="button" className="btn ghost-danger" disabled={busy} onClick={() => decide(false)}>{t("apps.decline")}</button>
        </div>
      </div>
    </article>
  );
}
