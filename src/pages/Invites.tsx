import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";

interface Invite {
  code: string;
  role: "admin" | "creator";
  note: string | null;
  used_at: string | null;
  created_at: string;
  user: { username: string } | null;
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `TOKI-${hex.slice(0, 6)}-${hex.slice(6)}`;
}

export function Invites() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const [list, setList] = useState<Invite[] | null>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState("");
  const [err, setErr] = useState(false);

  const load = () =>
    supabase
      .from("invites")
      .select("code, role, note, used_at, created_at, user:profiles!invites_used_by_fkey(username)")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) setErr(true);
        else setList(data as unknown as Invite[]);
      });
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("invites").insert({ code: newCode(), note: note.trim() || null, created_by: profile!.id });
    if (error) return setErr(true);
    setNote("");
    load();
  };
  const remove = async (code: string) => {
    await supabase.from("invites").delete().eq("code", code);
    load();
  };
  const copy = async (code: string) => {
    const link = `${window.location.origin}/signup?invite=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(code);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard blocked: code is visible to copy by hand */
    }
  };

  return (
    <section className="panel">
      <h1 className="h">{t("invites.title")}</h1>
      <p className="lead">{t("invites.subtitle")}</p>
      <form className="inline-form" onSubmit={create}>
        <input id="invite-note" maxLength={80} placeholder={t("invites.note")} aria-label={t("invites.note")} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary">{t("invites.create")}</button>
      </form>
      {err && <p className="error" role="alert">{t("error")}</p>}
      {list && list.length === 0 && <p className="msg">{t("invites.empty")}</p>}
      {list && list.length > 0 && (
        <ul className="table invites">
          {list.map((i) => (
            <li key={i.code}>
              <div className="info">
                <code>{i.code}</code>
                <span className="sub">
                  {i.note ? `${i.note} · ` : ""}
                  {i.role === "admin" ? `${t("invites.admin")} · ` : ""}
                  {i.user ? t("invites.usedBy", { name: i.user.username }) : t("invites.unused")}
                </span>
              </div>
              {!i.user && (
                <div className="actions">
                  <button type="button" className="btn" onClick={() => copy(i.code)}>{copied === i.code ? t("invites.copied") : t("invites.copy")}</button>
                  <button type="button" className="btn ghost-danger" onClick={() => remove(i.code)}>{t("invites.delete")}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
