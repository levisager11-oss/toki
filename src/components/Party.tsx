// Parties: friends who play together stay together (src/lib/party.ts).
// The bar under the top bar says who is in the party; the notice takes a member along when the
// leader opens another room; the chat sits next to the game.
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { useGames } from "../lib/useGames";
import { followTarget, isParty, joinParty, leaveParty, partyRoom, type Follow, type Party } from "../lib/party";
import { nudgeParty, refreshBadges, setParty, useBadges } from "../lib/useBadges";
import type { Game } from "../lib/types";
import { Avatar } from "./Avatar";
import { ChatView } from "./ChatView";
import { PeopleIcon } from "./icons";

// A member sees "Following …" this long (and can stay) before Toki takes them along.
const FOLLOW_MS = 4000;
const SEEN = "toki.party.seen";

function readSeen(): string {
  try {
    return sessionStorage.getItem(SEEN) ?? "";
  } catch {
    return "";
  }
}

/**
 * Takes a party member to the leader's room: each room once, after a short notice. A member
 * who stays, or leaves the room later, isn't pulled back in; the bar keeps a "Join" button.
 */
function useFollow(party: Party | null, me: string): { target: Follow | null; pending: boolean; stay: () => void } {
  const { games } = useGames();
  const location = useLocation();
  const navigate = useNavigate();
  const [seen, setSeen] = useState(readSeen);
  const mark = (key: string) => {
    setSeen(key);
    try {
      sessionStorage.setItem(SEEN, key);
    } catch {
      /* no storage: this visit remembers it */
    }
  };
  const target = followTarget(party, me, games, location);
  const key = target?.key ?? "";
  const there = !!target?.there;
  const pending = !!target && !there && seen !== key;
  const to = useRef("");
  to.current = target?.to ?? "";

  // Already there (e.g. joined through the invite): nothing to follow.
  useEffect(() => {
    if (key && there && seen !== key) mark(key);
  }, [key, there, seen]);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => {
      mark(key);
      navigate(to.current);
    }, FOLLOW_MS);
    return () => clearTimeout(id);
  }, [pending, key, navigate]);

  return { target, pending, stay: () => mark(key) };
}

/** Under the top bar, on every page: the player's party. Nothing while they are in none. */
export function PartyBar({ me }: { me: string }) {
  const { t } = useI18n();
  const { party } = useBadges();
  const { games } = useGames();
  const location = useLocation();
  const follow = useFollow(party, me);
  const [busy, setBusy] = useState(false);
  const shown = isParty(party);
  // Pages that fill the screen (the chat) leave room for the bar.
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!shown || !el) return;
    const root = document.documentElement.style;
    const update = () => root.setProperty("--party-h", `${el.offsetHeight}px`);
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.removeProperty("--party-h");
    };
  }, [shown]);
  if (!isParty(party)) return null;

  const leader = party.members.find((m) => m.id === party.leader);
  const lead = party.leader === me;
  const room = party.code ? games?.find((g) => g.id === party.game) : undefined;
  const leave = async () => {
    setBusy(true);
    try {
      await leaveParty();
      setParty(null);
      nudgeParty(party, me);
    } catch {
      refreshBadges();
    }
    setBusy(false);
  };
  const who = `@${leader?.username ?? "…"}`;
  const line = lead
    ? t(room ? "party.youLeadRoom" : "party.youLead", { title: room?.title ?? "" })
    : !follow.target ? t("party.leads", { who })
    : follow.target.there ? t("party.with", { who, title: follow.target.game.title })
    : t("party.leaderIn", { who, title: follow.target.game.title });
  const onChat = party.chat && location.pathname === `/chat/${party.chat}`;

  return (
    <>
      <aside className="party-bar" ref={bar} aria-label={t("party.title")}>
        <span className="party-who">
          <PeopleIcon />
          <b>{t("party.title")}</b>
          <span className="party-faces">
            {party.members.map((m) => (
              <span key={m.id} className={m.id === party.leader ? "is-leader" : ""} title={`@${m.username}${m.id === party.leader ? ` (${t("party.leader")})` : ""}`}>
                <Avatar person={m} size={24} />
                <span className="sr-only">@{m.username}{m.id === party.leader ? ` (${t("party.leader")})` : ""}</span>
              </span>
            ))}
          </span>
        </span>
        <span className="party-line">{line}</span>
        <span className="actions">
          {follow.target && !follow.target.there && <Link to={follow.target.to} className="btn primary">{t("invite.join")}</Link>}
          {party.chat && !onChat && <Link to={`/chat/${party.chat}`} className="btn">{t("nav.chat")}</Link>}
          <button type="button" className="btn" onClick={leave} disabled={busy}>{t("party.leave")}</button>
        </span>
      </aside>
      {follow.pending && follow.target && (
        <aside className="invite-pop party-follow" role="alert">
          <Avatar person={follow.target.leader} size={40} />
          <div>
            <p>{t("party.following", { who, title: follow.target.game.title })}</p>
            <div className="actions">
              <button type="button" className="btn" onClick={follow.stay}>{t("party.stay")}</button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

/**
 * On a game's page: joins the party an invite or a shared link names (once), and tells the
 * party the room the game says the player is in, which moves the party when they lead it.
 */
export function usePartyOnGame({ game, room, me, joinPartyId, joinCode, onJoined }: {
  game: Game | undefined;
  /** The room the game says the player is in. */
  room: string | null;
  me: string | undefined;
  /** The party in the page's address (?party=…), with the room's code next to it. */
  joinPartyId: string | null;
  joinCode: string | null;
  /** The address' party was dealt with (joined, or not possible): it can go from the address. */
  onJoined: () => void;
}) {
  const { party } = useBadges();
  const gameId = game?.multiplayer ? game.id : undefined;

  const done = useRef(onJoined);
  done.current = onJoined;
  useEffect(() => {
    if (!me || !gameId || !joinPartyId) return;
    let alive = true;
    joinParty(joinPartyId, joinCode)
      .then((p) => {
        if (!alive) return;
        setParty(p);
        nudgeParty(p, me);
      }, () => {})
      .finally(() => alive && done.current());
    return () => {
      alive = false;
    };
  }, [me, gameId, joinPartyId, joinCode]);

  const leads = !!me && party?.leader === me;
  // The room the party was last told for this game.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!leads || !gameId || room === told.current) return;
    const before = told.current;
    told.current = room;
    let sent = false;
    // A game that starts again has no room for a moment: only a room that stays closed counts.
    const id = setTimeout(() => {
      sent = true;
      partyRoom(gameId, room).then((p) => {
        setParty(p);
        nudgeParty(p, me);
      }, () => {});
    }, room ? 0 : 2500);
    return () => {
      clearTimeout(id);
      if (!sent) told.current = before;
    };
  }, [leads, gameId, room, me]);
  // Leaving the game's page leaves its room.
  useEffect(() => {
    if (!leads || !gameId) return;
    return () => {
      if (!told.current) return;
      told.current = null;
      partyRoom(gameId, null).then((p) => nudgeParty(p, me), () => {});
    };
  }, [leads, gameId, me]);
}

/** The party's chat, next to the game. Nothing while the player is in no party. */
export function PartyChat() {
  const { t } = useI18n();
  const { party } = useBadges();
  if (!isParty(party) || !party.chat) return null;
  return (
    <aside className="party-chat" aria-label={t("party.chat")}>
      <div className="party-chat-head">
        <b>{t("party.chat")}</b>
        <span className="sub">{party.members.map((m) => `@${m.username}`).join(", ")}</span>
      </div>
      <ChatView key={party.chat} chatId={party.chat} kind="party" compact />
    </aside>
  );
}
