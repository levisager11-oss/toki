import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ageOf, bornValue, MIN_AGE, PARENT_AGE, rememberTooYoung, setBirth } from "../lib/account";
import { BirthFields } from "./BirthFields";

/**
 * Accounts from before Toki asked for the age answer once, before they go on. Players under 13
 * can't have an account: theirs is deleted (they can still play without one).
 */
export function AgeGate() {
  const { t, lang } = useI18n();
  const { needsAge, ageAnswered, signOut } = useAuth();
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [parentOk, setParentOk] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [gone, setGone] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = needsAge || gone;

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);
  if (!open) return null;

  const born = bornValue(year, month);
  const age = born ? ageOf(born) : null;
  const needsParent = age !== null && age >= MIN_AGE && age < PARENT_AGE;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!born) return;
    // Everyone confirms what they chose, so a slip of the finger doesn't cost an account.
    if (!sure) return setSure(true);
    setBusy(true);
    setErr("");
    try {
      if ((await setBirth(born, parentOk)) === "too_young") {
        rememberTooYoung();
        setGone(true);
        await signOut().catch(() => {});
      } else {
        ageAnswered();
      }
    } catch {
      setErr(t("error"));
    }
    setBusy(false);
  };

  return (
    // No closing with Escape: the question has to be answered (or the player logs out).
    <dialog ref={dialog} className="invite-dialog age-gate" aria-labelledby="age-gate-title" onCancel={(e) => e.preventDefault()}>
      {gone ? (
        <div className="form">
          <h2 className="h" id="age-gate-title">{t("age.tooYoung.title")}</h2>
          <p>{t("age.deleted")}</p>
          <button type="button" className="btn primary" onClick={() => window.location.assign("/")}>{t("age.playOn")}</button>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <h2 className="h" id="age-gate-title">{t("age.gate.title")}</h2>
          <p>{t("age.gate.text")}</p>
          <BirthFields month={month} year={year} onMonth={(m) => { setMonth(m); setSure(false); }} onYear={(y) => { setYear(y); setSure(false); }} idPrefix="gate-born" />
          {needsParent && (
            <label className="fb-check">
              <input type="checkbox" required checked={parentOk} onChange={(e) => setParentOk(e.target.checked)} />
              <span>{t("age.parentOk")}</span>
            </label>
          )}
          {sure && born && <p className="check" role="status">{t("age.sure", { month: new Intl.DateTimeFormat(lang === "de" ? "de-CH" : "en", { month: "long", year: "numeric" }).format(new Date(Number(year), Number(month) - 1, 1)) })}</p>}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="actions">
            <button className="btn primary" disabled={busy || !born}>{busy ? t("loading") : sure ? t("age.confirm") : t("age.continue")}</button>
            <button type="button" className="btn" onClick={() => signOut()}>{t("nav.logout")}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
