// Play together: invite friends into the room you opened in a multiplayer game.
// The game keeps its own rooms; Toki only passes the room's code on (see src/lib/invites.ts).
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { invitePath, joinPath, maxPlayers, ROOM_CODE, roomCode } from "../lib/invites";
import { inviteToGame, isOnline, markNotificationsRead, myFriends, SocialError, type FriendRow, type Person } from "../lib/social";
import { clearInvite, nudge, refreshBadges, useBadges } from "../lib/useBadges";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { CloseIcon, PeopleIcon } from "./icons";

/**
 * The room the game says the player is in: toki.room(code) in toki-save.js, null when they left
 * it (or the game doesn't tell). Only messages from the game's frame and its own site count.
 * `run` changes when the game is loaded again: then the room is gone.
 */
export function useRoomBridge(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, run: string): string | null {
  const [room, setRoom] = useState<string | null>(null);
  const playUrl = game?.multiplayer ? game.play_url : undefined;
  useEffect(() => {
    setRoom(null);
    if (!playUrl) return;
    let origin: string;
    try {
      origin = new URL(playUrl).origin;
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const m = e.data as { toki?: number; type?: string; data?: unknown } | null;
      if (!m || m.toki !== 1 || m.type !== "room") return;
      setRoom(typeof m.data === "string" && ROOM_CODE.test(m.data) ? m.data : null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, playUrl, run]);
  return room;
}

// After an invite, the same friend can be invited again this much later (the server allows 15 s).
const AGAIN_MS = 20_000;

export interface Invites {
  /** The room's code: from the game, or typed by the player. */
  code: string | null;
  /** The game told the code itself. */
  fromGame: boolean;
  setTyped: (code: string | null) => void;
  /** Friends who get an invite as soon as a room is open. */
  waiting: string[];
  /** When each friend was invited. */
  sent: Record<string, number>;
  error: string;
  /** Invites now, or as soon as a room is open. A waiting friend is taken off the list again. */
  toggle: (friendId: string) => void;
  /** The last thing that happened, for the line under the game. */
  last: { name: string } | null;
  names: Record<string, string>;
  setNames: (friends: Person[]) => void;
}

/** Sends invites for one game; friends picked before a room is open are invited once it is. */
export function useGameInvites(game: Game | undefined, room: string | null, startWith: string | null): Invites {
  const { t } = useI18n();
  const gameId = game?.id;
  const [typed, setTyped] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [sent, setSent] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [last, setLast] = useState<{ name: string } | null>(null);
  const [names, setNameMap] = useState<Record<string, string>>({});
  const code = room ?? typed;

  // A friend picked on the friends list (known once the game has loaded) is first in line.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!startWith || started.current === startWith) return;
    started.current = startWith;
    setWaiting((w) => (w.includes(startWith) ? w : [...w, startWith]));
  }, [startWith]);

  // Another game: start over. (Not when the game only just loaded.)
  const lastGame = useRef(gameId);
  useEffect(() => {
    const before = lastGame.current;
    if (gameId) lastGame.current = gameId;
    if (!before || !gameId || before === gameId) return;
    setTyped(null);
    setWaiting([]);
    setSent({});
    setError("");
    setLast(null);
  }, [gameId]);

  const send = useCallback(
    async (friendId: string, withCode: string) => {
      if (!gameId) return;
      setError("");
      try {
        await inviteToGame(friendId, gameId, withCode);
        nudge(friendId);
        setSent((s) => ({ ...s, [friendId]: Date.now() }));
        setLast({ name: names[friendId] ?? "" });
      } catch (e) {
        setError(t(e instanceof SocialError ? e.key : "error"));
      }
    },
    [gameId, names, t],
  );

  // A room is open now: everyone picked before gets their invite.
  useEffect(() => {
    if (!code || !waiting.length) return;
    const list = waiting;
    setWaiting([]);
    list.forEach((id) => void send(id, code));
  }, [code, waiting, send]);

  const toggle = (friendId: string) => {
    if (code) void send(friendId, code);
    else setWaiting((w) => (w.includes(friendId) ? w.filter((x) => x !== friendId) : [...w, friendId]));
  };
  const setNames = useCallback((friends: Person[]) => setNameMap(Object.fromEntries(friends.map((f) => [f.id, f.username]))), []);

  return { code, fromGame: !!room, setTyped, waiting, sent, error, toggle, last, names, setNames };
}

/** "Invite friends" next to the game, and the window to pick them. */
export function InviteFriends({ game, invites, startOpen }: { game: Game; invites: Invites; startOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!!startOpen);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <PeopleIcon />{t("invite.button")}
      </button>
      {/* Outside the game's button row, so that row's layout rules don't reach into the window. */}
      {open && createPortal(<InviteDialog game={game} invites={invites} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function InviteDialog({ game, invites, onClose }: { game: Game; invites: Invites; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [badCode, setBadCode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { setNames } = invites;

  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal?.();
  }, []);
  useEffect(() => {
    let alive = true;
    myFriends().then(
      (rows) => {
        if (!alive) return;
        const list = rows.filter((r) => r.status === "friend");
        setFriends(list);
        setNames(list);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [setNames]);
  // "Invited" turns back into "Invite again" by itself.
  useEffect(() => {
    if (!Object.keys(invites.sent).length) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [invites.sent]);

  const useCode = (e: FormEvent) => {
    e.preventDefault();
    const c = roomCode(text, game.join_param);
    setBadCode(!c);
    if (c) invites.setTyped(c);
  };
  const max = maxPlayers(game);

  return (
    <dialog
      ref={ref}
      className="invite-dialog"
      aria-labelledby="invite-h"
      onClose={onClose}
      // A tap on the dark background closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="invite-box">
        <div className="sechead">
          <h2 id="invite-h">{t("invite.title", { title: game.title })}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("invite.close")}><CloseIcon /></button>
        </div>

        {invites.code ? (
          <p className="check good">
            {t("invite.room")} <b className="room-code">{invites.code}</b>
            {!invites.fromGame && <> <button type="button" className="linkish" onClick={() => invites.setTyped(null)}>{t("invite.change")}</button></>}
            <br />
            <span className="sub">{t("invite.roomHelp")}</span>
          </p>
        ) : (
          <>
            <ol className="invite-steps">
              <li>{t("invite.step1")}</li>
              <li>{t("invite.step2")}</li>
            </ol>
            <form className="form invite-code" onSubmit={useCode}>
              <label htmlFor="invite-code">{t("invite.codeLabel")}</label>
              <div className="row">
                <input
                  id="invite-code" value={text} onChange={(e) => { setText(e.target.value); setBadCode(false); }}
                  placeholder="ABCD" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={300}
                  aria-describedby="invite-code-help" aria-invalid={badCode}
                />
                <button className="btn" disabled={!text.trim()}>{t("invite.useCode")}</button>
              </div>
              <small id="invite-code-help">{t("invite.codeHelp")}</small>
              {badCode && <p className="error" role="alert">{t("soc.err.badCode")}</p>}
            </form>
          </>
        )}
        {invites.error && <p className="error" role="alert">{invites.error}</p>}

        <h3>{t("invite.friends")} {max && <span className="sub">{t("invite.upTo", { n: max })}</span>}</h3>
        {failed ? <p className="msg">{t("error")}</p> : friends === null ? <p className="msg">{t("loading")}</p> : friends.length === 0 ? (
          <p className="msg">{t("invite.noFriends")} <Link to="/friends" className="btn">{t("invite.findFriends")}</Link></p>
        ) : (
          <ul className="people">
            {friends.map((f) => {
              const on = isOnline(f.last_seen);
              const here = on && f.playing === game.id;
              const waits = invites.waiting.includes(f.id);
              const invited = now - (invites.sent[f.id] ?? 0) < AGAIN_MS;
              return (
                <li key={f.id}>
                  <span className="person">
                    <Avatar person={f} online={on} />
                    <span>
                      <b>@{f.username}</b>
                      <span className="sub">{here ? t("invite.here") : on ? t("soc.online") : t("soc.offline")}</span>
                    </span>
                  </span>
                  <button type="button" className={`btn ${waits ? "on" : ""}`} aria-pressed={waits || undefined} disabled={invited} onClick={() => invites.toggle(f.id)}>
                    {invited ? `✓ ${t("invite.invited")}` : waits ? t("invite.waiting") : invites.sent[f.id] ? t("invite.again") : t("invite.invite")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {friends && friends.length > 0 && <p className="note">{t("invite.note")}</p>}
      </div>
    </dialog>
  );
}

/** Under the game: what is going on with the invites, also while the window is closed. */
export function InviteStatus({ invites }: { invites: Invites }) {
  const { t } = useI18n();
  const waiting = invites.waiting.map((id) => invites.names[id]).filter(Boolean).map((n) => `@${n}`);
  if (invites.waiting.length && !invites.code) {
    return (
      <p className="hint invite-status" role="status">
        {waiting.length ? t("invite.statusWaiting", { who: waiting.join(", ") }) : t("invite.statusWaitingAny")}
      </p>
    );
  }
  if (invites.error) return <p className="hint invite-status error" role="alert">{invites.error}</p>;
  if (invites.last) return <p className="hint invite-status" role="status">✓ {invites.last.name ? t("invite.statusSent", { who: `@${invites.last.name}` }) : t("invite.statusSentAny")}</p>;
  return null;
}

/** "X invites you to play Y", anywhere on Toki, with Join and Not now. */
export function InvitePopup() {
  const { t } = useI18n();
  const { invite } = useBadges();
  const { games } = useGames();
  const navigate = useNavigate();
  const game = invite ? games?.find((g) => g.id === invite.game) : undefined;
  if (!invite || !game) return null;
  const answer = (join: boolean) => {
    clearInvite();
    // Read now: it doesn't pop up again, and stays in the bell's list.
    markNotificationsRead([invite.id]).then(refreshBadges, () => {});
    if (join) navigate(joinPath(game.slug, invite.code));
  };
  return (
    <aside className="invite-pop" role="alert">
      <Avatar person={invite.from} size={40} />
      <div>
        <p>{t("invite.popup", { who: `@${invite.from.username}`, title: game.title })}</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => answer(true)}>{t("invite.join")}</button>
          <button type="button" className="btn" onClick={() => answer(false)}>{t("invite.notNow")}</button>
        </div>
      </div>
    </aside>
  );
}

/**
 * "Invite to a game" next to a friend: pick one of the multiplayer games, which opens ready to
 * invite them as soon as a room is open. Nothing while Toki has no multiplayer games.
 */
export function InviteToGame({ friend }: { friend: { id: string } }) {
  const { t } = useI18n();
  const { games } = useGames();
  const ref = useRef<HTMLDetailsElement>(null);
  const multi = (games ?? []).filter((g) => g.multiplayer);
  // Closes when something else is clicked.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  if (!multi.length) return null;
  if (multi.length === 1) return <Link to={invitePath(multi[0].slug, friend.id)} className="btn">{t("invite.toGame")}</Link>;
  return (
    <details className="invite-menu" ref={ref}>
      <summary className="btn">{t("invite.toGame")}</summary>
      <ul>
        {multi.map((g) => (
          <li key={g.id}><Link to={invitePath(g.slug, friend.id)}>{g.title}</Link></li>
        ))}
      </ul>
    </details>
  );
}
