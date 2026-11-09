import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { supabase } from "../lib/supabase";
import { ago } from "../lib/feedback";
import { refreshBadges } from "../lib/useBadges";
import {
  deleteMessage, LIMITS, listMessages, markChatRead, MESSAGE_PAGE, reportMessage, sendMessage, SocialError,
  type ChatKind, type Message, type Person,
} from "../lib/social";
import { Avatar } from "./Avatar";

/**
 * The messages of one chat with a box to write. New messages arrive live (Supabase Realtime),
 * only while this is on screen. Deleted messages disappear on the next visit: listening for
 * deletes would send every deleted message (also the daily cleanup) to everyone online.
 */
export function ChatView({ chatId, kind, compact }: { chatId: string; kind: ChatKind; compact?: boolean }) {
  const { t, lang } = useI18n();
  const { session, profile } = useAuth();
  const location = useLocation();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [reported, setReported] = useState<Set<number>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep showing the newest message while the list is scrolled to the bottom
  const people = useRef(new Map<string, Person>());
  const me = session?.user.id;
  const isAdmin = profile?.role === "admin";
  const remember = (ms: Message[]) => ms.forEach((m) => m.author && people.current.set(m.author_id, m.author));

  const markRead = () => {
    if ((kind === "dm" || kind === "group") && document.visibilityState === "visible") markChatRead(chatId).then(refreshBadges, () => {});
  };

  useEffect(() => {
    if (!me) return;
    let alive = true;
    setMessages(null);
    stick.current = true;
    listMessages(chatId).then(
      (ms) => {
        if (!alive) return;
        remember(ms);
        setMessages(ms);
        setMore(ms.length === MESSAGE_PAGE);
        markRead();
      },
      () => alive && setErr(t("error")),
    );

    const channel = supabase
      .channel(`chat:${chatId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` }, async (payload) => {
        const m = payload.new as Message;
        let author = people.current.get(m.author_id);
        if (!author) {
          const { data } = await supabase.from("profiles").select("id, username, avatar_url, avatar_seed, role").eq("id", m.author_id).maybeSingle();
          if (data) people.current.set(m.author_id, (author = data as Person));
        }
        if (!alive) return;
        setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, { ...m, author }] : list));
        markRead();
      })
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [chatId, me]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = list.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const loadEarlier = async () => {
    if (!messages?.length) return;
    const el = list.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    const older = await listMessages(chatId, messages[0].id).catch(() => [] as Message[]);
    remember(older);
    setMore(older.length === MESSAGE_PAGE);
    stick.current = false;
    setMessages((list) => [...older, ...(list ?? [])]);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setErr("");
    setSending(true);
    try {
      const m = await sendMessage(chatId, body);
      remember([m]);
      stick.current = true;
      setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
      setText("");
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter makes a new line (not on phones, where Enter is the only way to break a line).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      send();
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteMessage(id);
      setMessages((list) => list?.filter((x) => x.id !== id) ?? list);
    } catch {
      setErr(t("error"));
    }
  };
  const report = async (e: FormEvent) => {
    e.preventDefault();
    if (reporting === null) return;
    try {
      await reportMessage(reporting, reason.trim());
      setReported((s) => new Set(s).add(reporting));
      setReporting(null);
      setReason("");
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    }
  };

  if (!session)
    return (
      <div className="chat-view guest">
        <p className="msg">{t("chat.loginToChat")}</p>
        <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="btn primary">{t("nav.login")}</Link>
      </div>
    );

  return (
    <div className={`chat-view ${compact ? "compact" : ""}`}>
      <div className="messages" ref={list} onScroll={onScroll} aria-live="polite" aria-busy={messages === null}>
        {more && <button type="button" className="linkish earlier" onClick={loadEarlier}>{t("chat.earlier")}</button>}
        {messages === null && !err && <p className="msg">{t("loading")}</p>}
        {messages?.length === 0 && <p className="msg empty">{t(kind === "public" || kind === "game" ? "chat.emptyRoom" : "chat.empty")}</p>}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.author_id === m.author_id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
          const mine = m.author_id === me;
          const who = m.author ?? people.current.get(m.author_id);
          return (
            // Focusable, so on phones a tap shows the message's Delete and Report links.
            <div key={m.id} className={`msg-row ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`} tabIndex={-1}>
              {!grouped && (
                <div className="msg-head">
                  <Link to={`/u/${who?.username ?? ""}`} className="person"><Avatar person={who} size={24} /><b>@{who?.username ?? "…"}</b></Link>
                  {who?.role && who.role !== "player" && <span className="role-badge">{t(who.role === "admin" ? "soc.role.admin" : "soc.role.dev")}</span>}
                  <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString(lang === "de" ? "de-CH" : "en")}>{ago(m.created_at, lang)}</time>
                </div>
              )}
              <p className="body">{m.body}</p>
              <div className="msg-tools">
                {(mine || isAdmin) && <button type="button" className="linkish" onClick={() => remove(m.id)}>{t("chat.delete")}</button>}
                {!mine && (reported.has(m.id)
                  ? <span className="sub">{t("chat.reported")}</span>
                  : <button type="button" className="linkish" onClick={() => setReporting(m.id)}>{t("chat.report")}</button>)}
              </div>
              {reporting === m.id && (
                <form className="inline-form report-form" onSubmit={report}>
                  <input autoFocus maxLength={LIMITS.reason} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("chat.reportWhy")} aria-label={t("chat.reportWhy")} />
                  <button className="btn">{t("chat.sendReport")}</button>
                  <button type="button" className="btn" onClick={() => setReporting(null)}>{t("form.cancel")}</button>
                </form>
              )}
            </div>
          );
        })}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      <form className="composer" onSubmit={send}>
        <textarea rows={1} maxLength={LIMITS.message} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={t("chat.placeholder")} aria-label={t("chat.placeholder")} enterKeyHint="send" />
        <button className="btn primary" disabled={sending || !text.trim()}>{t("chat.send")}</button>
      </form>
      {(kind === "public" || kind === "game") && <p className="hint">{t("chat.roomRules")}</p>}
    </div>
  );
}
