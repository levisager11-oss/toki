// Play together: a multiplayer game keeps its own rooms and room codes. Toki brings friends
// into the same room: it opens the game with the code in its address (<game>?room=ABCD), the
// way the game's own invite links work. Rules: supabase/migrations/20261117090000_game_invites.sql.
import type { Game } from "./types";

/** Room codes are short and plain, so they are safe in an address and easy to read out. */
export const ROOM_CODE = /^[A-Za-z0-9_-]{1,32}$/;
/** An invite can be accepted for this long: rooms don't stay open forever, and codes get reused. */
export const INVITE_MS = 30 * 60_000;

/**
 * The room code in what a player typed or pasted: the code itself, or one of the game's invite
 * links (…?room=ABCD). Null if it isn't one.
 */
export function roomCode(input: string | null | undefined, param = "room"): string | null {
  let s = (input ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const q = new URL(s).searchParams;
      s = q.get(param) ?? q.get("room") ?? q.get("join") ?? q.get("code") ?? "";
    } catch {
      return null;
    }
  }
  return ROOM_CODE.test(s) ? s : null;
}

/**
 * What a message from the game's frame says about its room: the code, null (the player left it,
 * or the game started again: toki-save.js says "hello" each time its page loads, e.g. when a
 * game reloads itself for a new save), or undefined when the message isn't about rooms.
 */
export function roomFromMessage(data: unknown): string | null | undefined {
  const m = data as { toki?: number; type?: string; data?: unknown } | null;
  if (!m || typeof m !== "object" || m.toki !== 1) return undefined;
  if (m.type === "hello") return null;
  if (m.type !== "room") return undefined;
  return typeof m.data === "string" && ROOM_CODE.test(m.data) ? m.data : null;
}

/**
 * Whether the game can open a room by itself when Toki asks (toki.onHost in toki-save.js):
 * true or false when the game says so, false when it starts again, undefined for other messages.
 */
export function hostFromMessage(data: unknown): boolean | undefined {
  const m = data as { toki?: number; type?: string; data?: unknown } | null;
  if (!m || typeof m !== "object" || m.toki !== 1) return undefined;
  if (m.type === "hello") return false;
  return m.type === "host" ? m.data === true : undefined;
}

/** What Toki sends the game to have it open a room (the game set toki.onHost). */
export const HOST_MESSAGE = { toki: 1, type: "host" } as const;

/** The game's address that joins this room, or its normal address without a (valid) code. */
export function playUrl(game: Pick<Game, "play_url" | "multiplayer" | "join_param">, code: string | null): string {
  if (!code || !game.multiplayer || !ROOM_CODE.test(code)) return game.play_url;
  try {
    const u = new URL(game.play_url);
    u.searchParams.set(game.join_param || "room", code);
    return u.toString();
  } catch {
    return game.play_url;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A party's id from an address, or null. */
export const partyId = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/** The game's page on Toki that joins this room, and the party of whoever invited (if any). */
export const joinPath = (slug: string, code: string, party?: string | null) =>
  `/game/${slug}?room=${encodeURIComponent(code)}${partyId(party) ? `&party=${party}` : ""}`;
/** The game's page on Toki, ready to invite this friend as soon as a room is open. */
export const invitePath = (slug: string, friendId: string) => `/game/${slug}?invite=${encodeURIComponent(friendId)}`;

/** "2–4 players" needs the number; games that don't say show just "Multiplayer". */
export const maxPlayers = (game: Pick<Game, "max_players">) =>
  typeof game.max_players === "number" && game.max_players >= 2 ? game.max_players : null;
