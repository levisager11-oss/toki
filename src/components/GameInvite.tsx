// Play together: invite friends into the room you opened in a multiplayer game.
// The game keeps its own rooms; Toki only passes the room's code on (see src/lib/invites.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { HOST_MESSAGE, hostFromMessage, invitePath, joinPath, maxPlayers, NAME_MAX, nameMessage, namesFromMessage, roomCode, roomFromMessage } from "../lib/invites";
import { usePlayerName } from "../lib/playerName";
import { openParty } from "../lib/party";
import { pushInvite } from "../lib/push";
import { inviteToGame, isOnline, markNotificationsRead, myFriends, SocialError, type FriendRow, type Person } from "../lib/social";
import { clearInvite, nudge, refreshBadges, setParty, useBadges } from "../lib/useBadges";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { CloseIcon, PeopleIcon } from "./icons";
import { PushSwitch } from "./PushSwitch";
import { ShareButton } from "./ShareButton";

export interface RoomBridge {
  /** The room the game says the player is in, null when they left it (or the game doesn't tell). */
  room: string | null;
  /** The game can open a room by itself when Toki asks (toki.onHost). */
  canHost: boolean;
  /** Asks the game to open a room. */
  askHost: () => void;
  /** The game uses the name the player goes by, from Toki (toki.onName). */
  usesName: boolean;
}

/**
 * What the game tells Toki about its multiplayer: toki.room(code) and toki.onHost(fn) in
 * toki-save.js. Only messages from the game's frame and its own site count.
 * It all starts over when the game is loaded again: by Toki (`run` changes), or by itself.
 */
export function useRoomBridge(frame: RefObject<HTMLIFrameElement>, game: Game | undefined, run: string): RoomBridge {
  const [room, setRoom] = useState<string | null>(null);
  const [canHost, setCanHost] = useState(false);
  const [usesName, setUsesName] = useState(false);
  // The game hears the name as soon as its script says hello, and again when it changes.
  const { name } = usePlayerName();
  const nameNow = useRef(name);
  nameNow.current = name;
  const playUrl = game?.multiplayer ? game.play_url : undefined;
  const origin = useMemo(() => {
    try {
      return playUrl ? new URL(playUrl).origin : null;
    } catch {
      return null;
    }
  }, [playUrl]);
  useEffect(() => {
    setRoom(null);
    setCanHost(false);
    setUsesName(false);
    if (!origin) return;
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== origin) return;
      const next = roomFromMessage(e.data);
      if (next !== undefined) setRoom(next);
      const host = hostFromMessage(e.data);
      if (host !== undefined) setCanHost(host);
      const names = namesFromMessage(e.data);
      if (names !== undefined) setUsesName(names);
      if ((e.data as { type?: string } | null)?.type === "hello" && nameNow.current) win.postMessage(nameMessage(nameNow.current), origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, origin, run]);
  const askHost = useCallback(() => {
    if (origin) frame.current?.contentWindow?.postMessage(HOST_MESSAGE, origin);
  }, [frame, origin]);
  // A new name (chosen in Toki while playing) reaches the game at once.
  useEffect(() => {
    if (origin && name) frame.current?.contentWindow?.postMessage(nameMessage(name), origin);
  }, [frame, origin, name]);
  return { room, canHost, askHost, usesName };
}

/**
 * "Your name in the game", for games that use the name from Toki: the player's Toki name until
 * they choose another (guests choose one). Saved as they type; the game hears it at once.
 */
export function GameNameField({ id, guest }: { id: string; guest?: boolean }) {
  const { t } = useI18n();
  const { chosen, fallback, setName } = usePlayerName();
  const [text, setText] = useState(chosen || fallback);
  useEffect(() => setText(chosen || fallback), [chosen, fallback]);
  return (
    <div className="form game-name">
      <label htmlFor={id}>{t("name.label")}</label>
      <input
        id={id} value={text} maxLength={NAME_MAX} autoComplete="nickname" spellCheck={false}
        placeholder={guest ? t("name.placeholderGuest") : fallback}
        onChange={(e) => { setText(e.target.value); setName(e.target.value); }}
        onBlur={() => setText(chosen || fallback)}
        aria-describedby={`${id}-help`}
      />
      <small id={`${id}-help`}>{t(guest ? "name.helpGuest" : "name.help")}</small>
    </div>
  );
}

// The game gets this long to open the room Toki asked for; then the player is told how to.
const HOST_WAIT_MS = 8000;

// After an invite, the same friend can be invited again this much later (the server allows 15 s).
const AGAIN_MS = 20_000;

export interface Invites {
  /** The room's code: from the game, or typed by the player. */
  code: string | null;
  /** The game told the code itself. */
  fromGame: boolean;
  setTyped: (code: string | null) => void;
  /**
   * The game opens the room by itself: "can" when it would, "opening" while Toki waits for it,
   * "no" when the player has to (the game can't, or didn't in time).
   */
  host: "can" | "opening" | "no";
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
export function useGameInvites(game: Game | undefined, bridge: RoomBridge, startWith: string | null): Invites {
  const { t } = useI18n();
  const gameId = game?.id;
  const { room, canHost, askHost } = bridge;
  const [typed, setTyped] = useState<string | null>(null);
  // When the game was asked to open a room; -1 once it didn't in time.
  const [asked, setAsked] = useState(0);
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
    setAsked(0);
  }, [gameId]);

  // Friends are picked and no room is open: the game opens one, if it can.
  const wantsRoom = waiting.length > 0 && !code;
  useEffect(() => {
    // The game started again: it may be asked again.
    if (!canHost) return setAsked(0);
    if (!wantsRoom) return setAsked((a) => (a > 0 ? 0 : a));
    if (asked) return;
    askHost();
    setAsked(Date.now());
  }, [wantsRoom, canHost, asked, askHost]);
  useEffect(() => {
    if (asked <= 0) return;
    const id = setTimeout(() => setAsked(-1), HOST_WAIT_MS);
    return () => clearTimeout(id);
  }, [asked]);
  // A room is open (however it came about): next time the game may be asked again.
  useEffect(() => {
    if (code) setAsked(0);
  }, [code]);
  const host = !canHost || asked < 0 ? "no" : asked > 0 ? "opening" : "can";

  const send = useCallback(
    async (friendId: string, withCode: string) => {
      if (!gameId) return;
      setError("");
      try {
        await inviteToGame(friendId, gameId, withCode);
        nudge(friendId);
        // A friend who isn't on Toki gets it on their phone or computer, if they turned that on.
        pushInvite(friendId);
        // Whoever invites has a party now: the friend who accepts is in it.
        refreshBadges();
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

  return { code, fromGame: !!room, setTyped, host, waiting, sent, error, toggle, last, names, setNames };
}

/** "Invite friends" next to the game, and the window to pick them. */
export function InviteFriends({ game, invites, startOpen, usesName }: { game: Game; invites: Invites; startOpen?: boolean; usesName?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!!startOpen);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <PeopleIcon />{t("invite.button")}
      </button>
      {/* Outside the game's button row, so that row's layout rules don't reach into the window. */}
      {open && createPortal(<InviteDialog game={game} invites={invites} usesName={!!usesName} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function InviteDialog({ game, invites, usesName, onClose }: { game: Game; invites: Invites; usesName: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const { party } = useBadges();
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
  // The link to share brings friends into the player's party: there is one from here on.
  const { code } = invites;
  useEffect(() => {
    if (!code) return;
    let alive = true;
    openParty(game.id, code).then((p) => alive && setParty(p), () => {});
    return () => {
      alive = false;
    };
  }, [game.id, code]);
  const inParty = new Set(party && party.members.length > 1 ? party.members.map((m) => m.id) : []);
  inParty.delete(session?.user.id ?? "");

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

        {usesName && <GameNameField id="invite-name" />}
        {invites.code ? (
          <>
            <p className="check good">
              {t("invite.room")} <b className="room-code">{invites.code}</b>
              {!invites.fromGame && <> <button type="button" className="linkish" onClick={() => invites.setTyped(null)}>{t("invite.change")}</button></>}
              <br />
              <span className="sub">{t("invite.roomHelp")}</span>
            </p>
            <div className="invite-share">
              <ShareButton path={joinPath(game.slug, invites.code, party?.id)} title={game.title} text={t("invite.shareText", { title: game.title })} label={t("invite.share")} />
              <span className="sub">{t("invite.shareHelp")}</span>
            </div>
          </>
        ) : invites.host === "opening" ? (
          <p className="check" role="status" aria-busy="true">{t("invite.opening")}</p>
        ) : invites.host === "can" ? (
          <p className="check">{t("invite.autoRoom")}</p>
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
              const with_ = inParty.has(f.id);
              return (
                <li key={f.id}>
                  <span className="person">
                    <Avatar person={f} online={on} />
                    <span>
                      <b>@{f.username}</b>
                      <span className="sub">{with_ ? t("party.inYours") : here ? t("invite.here") : on ? t("soc.online") : t("soc.offline")}</span>
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
        <PushSwitch />
      </div>
    </dialog>
  );
}

/** Under the game: what is going on with the invites, also while the window is closed. */
export function InviteStatus({ invites }: { invites: Invites }) {
  const { t } = useI18n();
  const waiting = invites.waiting.map((id) => invites.names[id]).filter(Boolean).map((n) => `@${n}`);
  if (invites.waiting.length && !invites.code) {
    if (invites.host !== "no") return <p className="hint invite-status" role="status">{t("invite.opening")}</p>;
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
    if (join) navigate(joinPath(game.slug, invite.code, invite.party));
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
