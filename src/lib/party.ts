// Parties: friends who play together stay together. A party comes together when a friend
// accepts a game invite; its leader's room is the party's room, and everyone else follows.
// Rules: supabase/migrations/20261122090000_parties.sql.
import { supabase } from "./supabase";
import { joinPath } from "./invites";
import { SocialError, socialErrorKey, type Person } from "./social";
import type { Game } from "./types";

export interface PartyMember extends Person {
  /** The game they have open right now. */
  playing: string | null;
}

export interface Party {
  id: string;
  leader: string;
  /** The leader's room: the game and its code (null while the leader is in no room). */
  game: string | null;
  code: string | null;
  /** Counts the rooms the leader opened, so each one is followed once. */
  seq: number;
  chat: string | null;
  members: PartyMember[];
}

export const PARTY_MAX = 8;

export function readParty(v: unknown): Party | null {
  const p = v as Partial<Party> | null;
  if (!p || typeof p.id !== "string" || typeof p.leader !== "string" || !Array.isArray(p.members)) return null;
  return {
    id: p.id,
    leader: p.leader,
    game: typeof p.game === "string" ? p.game : null,
    code: typeof p.code === "string" ? p.code : null,
    seq: Number(p.seq) || 0,
    chat: typeof p.chat === "string" ? p.chat : null,
    members: p.members.filter((m) => m && typeof m.id === "string" && typeof m.username === "string"),
  };
}

/** A party of one (someone who invited, and nobody came yet) doesn't show. */
export const isParty = (p: Party | null | undefined): p is Party => !!p && p.members.length > 1;

async function rpc(fn: string, args?: Record<string, unknown>): Promise<Party | null> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new SocialError(socialErrorKey(error));
  return readParty(data);
}

/** Joins the party of whoever invited (p_code: the room's code from a shared link). */
export const joinParty = (party: string, code: string | null) => rpc("join_party", { p_party: party, p_code: code });
export const leaveParty = () => rpc("leave_party").then(() => {});
/** The game told Toki the player's room (null: they left it). Moves the party when they lead it. */
export const partyRoom = (gameId: string, code: string | null) => rpc("party_room", { p_game: gameId, p_code: code });
/** The player's party in this room, made now if they have none: for a link to share. */
export const openParty = (gameId: string, code: string) => rpc("open_party", { p_game: gameId, p_code: code });

export interface Follow {
  /** Which room of which party: followed (or declined) once. */
  key: string;
  to: string;
  game: Pick<Game, "id" | "slug" | "title">;
  leader: PartyMember | undefined;
  /** The player is in that room already. */
  there: boolean;
}

/**
 * Where a party member should be: the leader's room, unless they lead themselves or the
 * leader is in no room. `at` is the page they are on.
 */
export function followTarget(
  party: Party | null, me: string | undefined, games: Pick<Game, "id" | "slug" | "title">[] | null | undefined,
  at: { pathname: string; search: string },
): Follow | null {
  if (!isParty(party) || !me || party.leader === me || !party.code || !party.game) return null;
  const game = games?.find((g) => g.id === party.game);
  if (!game) return null;
  const there = at.pathname.replace(/\/$/, "") === `/game/${game.slug}` && new URLSearchParams(at.search).get("room") === party.code;
  return {
    key: `${party.id}:${party.seq}`,
    to: joinPath(game.slug, party.code),
    game,
    leader: party.members.find((m) => m.id === party.leader),
    there,
  };
}
