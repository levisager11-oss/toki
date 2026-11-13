import { useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { ago } from "../lib/feedback";
import { addNote, NOTE_LIMITS, type Application, type ApplicationNote } from "../lib/applications";

/**
 * The questions and answers on an open developer application. `as`: who is looking: an admin
 * asks, the applicant answers. Nothing to show and nothing to write for the applicant until an
 * admin asked something.
 */
export function ApplicationNotes({ app, as }: { app: Application; as: "admin" | "applicant" }) {
  const { t, lang } = useI18n();
  const [notes, setNotes] = useState<ApplicationNote[]>(app.notes ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (as === "applicant" && notes.length === 0) return null;
  const id = `note-text-${app.id}`;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr("");
    try {
      setNotes(await addNote(app.id, text));
      setText("");
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setErr(t(code === "closed" ? "appNotes.closed" : code === "full" ? "appNotes.full" : "error"));
    }
    setBusy(false);
  };

  return (
    <div className="app-notes">
      <h3 className="label">{t(as === "admin" ? "appNotes.titleAdmin" : "appNotes.title")}</h3>
      {notes.length > 0 && (
        <ul className="app-notes-list">
          {notes.map((n, i) => (
            <li key={i} className={n.by === "admin" ? "from-admin" : "from-applicant"}>
              <span className="sub">{t(n.by === "admin" ? "appNotes.byAdmin" : as === "applicant" ? "appNotes.byYou" : "appNotes.byApplicant")} · {ago(n.at, lang)}</span>
              <p className="fb-body">{n.text}</p>
            </li>
          ))}
        </ul>
      )}
      {notes.length < NOTE_LIMITS.count && (
        <form className="form" onSubmit={send}>
          <label htmlFor={id} className="sr-only">{t(as === "admin" ? "appNotes.ask" : "appNotes.answer")}</label>
          <textarea id={id} rows={2} maxLength={NOTE_LIMITS.text} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={t(as === "admin" ? "appNotes.askPlaceholder" : "appNotes.answerPlaceholder")} />
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions fb-form-actions">
            <button className="btn" disabled={busy || !text.trim()}>{busy ? t("fb.form.sending") : t(as === "admin" ? "appNotes.ask" : "appNotes.answer")}</button>
          </div>
        </form>
      )}
      {as === "admin" && <small>{t("appNotes.adminHelp")}</small>}
    </div>
  );
}
