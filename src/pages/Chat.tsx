import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { ago } from "../lib/feedback";
import { refreshBadges } from "../lib/useBadges";
import {
  addToGroup, chatMembers, createGroup, getChat, leaveGroup, LIMITS, myChats, myFriends, renameGroup, roomId,
  SocialError, type Chat as ChatInfo, type ChatSummary, type FriendRow, type Person,
} from "../lib/social";
import { Avatar } from "../components/Avatar";
import { ChatView } from "../components/ChatView";
import { useBadges } from "../lib/useBadges";
import { useTitle } from "../lib/useTitle";

/** /chat: the list of chats. /chat/toki: the public room. /chat/:id: one chat. /chat/new: a new group. */
export function Chat() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { games } = useGames();
  const { chats: unreadChats } = useBadges();
  const navigate = useNavigate();
  const [list, setList] = useState<ChatSummary[] | null>(null);
  const [chat, setChat] = useState<ChatInfo | null | undefined>(undefined);
  const [err, setErr] = useState("");

  // The list, again whenever something becomes unread or read.
  useEffect(() => {
    let alive = true;
    myChats().then((c) => alive && setList(c), () => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [id, unreadChats]);

  useEffect(() => {
    let alive = true;
    setErr("");
    if (!id || id === "new") {
      setChat(undefined);
      return;
    }
    setChat(undefined);
    const load = id === "toki" ? roomId(null).then(getChat) : getChat(id);
    load.then((c) => alive && setChat(c), (e) => alive && (setErr(t(e instanceof SocialError ? e.key : "error")), setChat(null)));
    return () => {
      alive = false;
    };
  }, [id, t]);

  const title = (c: { kind: string; title: string | null; game_id: string | null; other_username?: string | null }) =>
    c.kind === "public" ? t("chat.toki")
      : c.kind === "game" ? games?.find((g) => g.id === c.game_id)?.title ?? t("chat.gameRoom")
      : c.kind === "dm" ? `@${c.other_username ?? "…"}`
      : c.title ?? "";
  const summary = chat ? list?.find((c) => c.id === chat.id) : undefined;
  const open = !!id;
  useTitle(chat ? title({ ...chat, other_username: summary?.other_username }) || t("nav.chat") : t("nav.chat"));

  return (
    <section className={`chat-layout ${open ? "has-chat" : ""}`}>
      <aside className="chat-list">
        <div className="sechead">
          <h1 className="h">{t("nav.chat")}</h1>
          <div className="actions">
            <Link to="/friends" className="btn">{t("soc.friends")}</Link>
            <Link to="/chat/new" className="btn">{t("chat.newGroup")}</Link>
          </div>
        </div>
        <ul className="chats">
          <li>
            <Link to="/chat/toki" className={id === "toki" || chat?.kind === "public" ? "on" : ""}>
              <span className="avatar room-icon" aria-hidden="true">#</span>
              <span className="chat-txt"><b>{t("chat.toki")}</b><span className="sub">{t("chat.tokiHelp")}</span></span>
            </Link>
          </li>
          {list?.map((c) => (
            <li key={c.id}>
              <Link to={`/chat/${c.id}`} className={chat?.id === c.id ? "on" : ""}>
                {c.kind === "dm"
                  ? <Avatar person={{ username: c.other_username ?? "", avatar_url: c.other_avatar_url, avatar_seed: c.other_avatar_seed }} />
                  : <span className="avatar room-icon" aria-hidden="true">{c.members}</span>}
                <span className="chat-txt">
                  <b>{title(c)}</b>
                  <span className="sub">
                    {c.last_body ? `${c.kind === "group" && c.last_author ? `@${c.last_author}: ` : ""}${c.last_body}` : t("chat.noMessages")}
                  </span>
                </span>
                <span className="chat-side">
                  {c.last_message_at && <time className="sub">{ago(c.last_message_at, lang)}</time>}
                  {c.unread > 0 && <span className="count-pill" aria-label={t("chat.unread", { n: c.unread })}>{c.unread}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {list?.length === 0 && <p className="hint">{t("chat.noChats")}</p>}
      </aside>

      <div className="chat-main">
        {open && <Link to="/chat" className="back mobile-only">← {t("nav.chat")}</Link>}
        {id === "new" ? (
          <NewGroup onDone={(chatId) => navigate(`/chat/${chatId}`)} />
        ) : !id ? (
          <p className="msg desktop-only">{t("chat.pick")}</p>
        ) : chat === undefined ? (
          <p className="msg">{err || t("loading")}</p>
        ) : chat === null ? (
          <p className="msg">{err || t("chat.notFound")}</p>
        ) : (
          <>
            <ChatHeader chat={chat} summary={summary} title={title({ ...chat, other_username: summary?.other_username })}
              onRenamed={(name) => setChat({ ...chat, title: name })} onLeft={() => { refreshBadges(); navigate("/chat"); }} />
            <ChatView key={chat.id} chatId={chat.id} kind={chat.kind} unread={list ? summary?.unread ?? 0 : undefined} />
          </>
        )}
      </div>
    </section>
  );
}

function ChatHeader({ chat, summary, title, onRenamed, onLeft }: {
  chat: ChatInfo; summary?: ChatSummary; title: string; onRenamed: (name: string) => void; onLeft: () => void;
}) {
  const { t } = useI18n();
  const { games } = useGames();
  const [members, setMembers] = useState<Person[] | null>(null);
  const [settings, setSettings] = useState(false);
  const game = chat.game_id ? games?.find((g) => g.id === chat.game_id) : undefined;

  useEffect(() => {
    if (chat.kind !== "group") return;
    chatMembers(chat.id).then(setMembers, () => {});
  }, [chat.id, chat.kind, settings]);

  return (
    <header className="chat-head">
      {chat.kind === "dm" && summary?.other_username ? (
        <Link to={`/u/${summary.other_username}`} className="person">
          <Avatar person={{ username: summary.other_username, avatar_url: summary.other_avatar_url, avatar_seed: summary.other_avatar_seed }} size={32} />
          <h2>{title}</h2>
        </Link>
      ) : chat.kind === "game" && game ? (
        <Link to={`/game/${game.slug}`} className="person"><h2>{title}</h2></Link>
      ) : (
        <h2>{title}</h2>
      )}
      {chat.kind === "group" && (
        <>
          <span className="sub">{members?.map((m) => `@${m.username}`).join(", ")}</span>
          <button type="button" className="btn" aria-expanded={settings} onClick={() => setSettings((s) => !s)}>{t("chat.settings")}</button>
        </>
      )}
      {settings && chat.kind === "group" && <GroupSettings chat={chat} members={members ?? []} onChanged={() => setSettings(false)} onRenamed={(n) => { onRenamed(n); setSettings(false); }} onLeft={onLeft} />}
    </header>
  );
}

function GroupSettings({ chat, members, onChanged, onRenamed, onLeft }: {
  chat: ChatInfo; members: Person[]; onChanged: () => void; onRenamed: (name: string) => void; onLeft: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(chat.title ?? "");
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    myFriends().then((f) => setFriends(f.filter((x) => x.status === "friend")), () => {});
  }, []);
  const inGroup = new Set(members.map((m) => m.id));
  const run = async (fn: () => Promise<void>, after: () => void) => {
    setErr("");
    try {
      await fn();
      after();
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    }
  };
  return (
    <div className="group-settings">
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => renameGroup(chat.id, name.trim()), () => onRenamed(name.trim())); }}>
        <input required maxLength={LIMITS.groupTitle} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("chat.groupName")} />
        <button className="btn">{t("chat.rename")}</button>
      </form>
      <h3>{t("chat.addPeople")}</h3>
      <ul className="people">
        {friends.filter((f) => !inGroup.has(f.id)).map((f) => (
          <li key={f.id}>
            <span className="person"><Avatar person={f} /><b>@{f.username}</b></span>
            <button type="button" className="btn" onClick={() => run(() => addToGroup(chat.id, f.id), onChanged)}>{t("chat.add")}</button>
          </li>
        ))}
      </ul>
      {friends.every((f) => inGroup.has(f.id)) && <p className="hint">{t("chat.allFriendsIn")}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <button type="button" className="btn ghost-danger" onClick={() => run(() => leaveGroup(chat.id), onLeft)}>{t("chat.leave")}</button>
    </div>
  );
}

function NewGroup({ onDone }: { onDone: (chatId: string) => void }) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    myFriends().then((f) => setFriends(f.filter((x) => x.status === "friend")), () => setFriends([]));
  }, []);
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else if (n.size < 19) n.add(id);
    return n;
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked.size) return setErr(t("chat.pickFriends"));
    setErr("");
    setBusy(true);
    try {
      onDone(await createGroup(name.trim() || t("chat.defaultGroup", { name: profile?.username ?? "" }), [...picked]));
      refreshBadges();
    } catch (e) {
      setErr(t(e instanceof SocialError ? e.key : "error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form new-group" onSubmit={submit}>
      <h2>{t("chat.newGroup")}</h2>
      <label htmlFor="gname">{t("chat.groupName")}</label>
      <input id="gname" maxLength={LIMITS.groupTitle} value={name} onChange={(e) => setName(e.target.value)} />
      <span className="label-text">{t("chat.whoIn")}</span>
      {friends === null ? <p className="msg">{t("loading")}</p> : friends.length === 0 ? (
        <p className="msg">{t("chat.needFriends")} <Link to="/friends">{t("soc.findPlayers")}</Link></p>
      ) : (
        <ul className="people pick">
          {friends.map((f) => (
            <li key={f.id}>
              <label className="check">
                <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} />
                <Avatar person={f} /> @{f.username}
              </label>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy || !friends?.length}>{t("chat.create")}</button>
    </form>
  );
}
