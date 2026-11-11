// The free AI's small helpers for the pages (the AI itself runs on the server, api/assist.ts).
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { api } from "./api";

export type Lang = "en" | "de";

export interface AiStatus {
  /** the free AI: small helpers */
  free: boolean;
  /** the strong AI: Toki Connect and bug fixes */
  strong: boolean;
}

let status: Promise<AiStatus> | null = null;
/** Which AI is on (asked once per visit), so buttons only show when the AI behind them works. */
export function useAiStatus(): AiStatus {
  const [s, setS] = useState<AiStatus>({ free: false, strong: false });
  useEffect(() => {
    let alive = true;
    status ??= Promise.resolve(supabase.rpc("ai_status")).then(
      ({ data, error }) => (error || !data ? { free: false, strong: false } : { free: data.free === true, strong: data.strong === true }),
      () => ({ free: false, strong: false }),
    );
    status.then((v) => alive && setS(v));
    return () => {
      alive = false;
    };
  }, []);
  return s;
}

/** Whether the free AI's helpers are on. */
export const useFreeAi = () => useAiStatus().free;

const assist = <T,>(body: Record<string, unknown>) => api<T>("/api/assist", { method: "POST", body: JSON.stringify(body) });

const DE = /\b(und|der|die|das|ist|nicht|ich|ein|eine|einen|mit|zu|auf|für|wenn|auch|sie|wir|du|bei|kann|spiel|nach|noch|aber|sehr|wird|dem|den|von|geht|bitte|wäre|habe|keine|immer)\b/gi;
const EN = /\b(the|and|is|not|it|this|with|to|on|for|when|also|you|we|can|game|after|but|very|will|of|my|have|are|was|please|would|doesn't|don't|there)\b/gi;

/** "en" or "de" when a text is clearly in that language; null when it's too short or unclear. */
export function detectLang(text: string): Lang | null {
  const de = (text.match(DE)?.length ?? 0) + Math.min(2, text.match(/[äöüß]/gi)?.length ?? 0);
  const en = text.match(EN)?.length ?? 0;
  if (de >= 2 && de > en * 1.5) return "de";
  if (en >= 2 && en > de * 1.5) return "en";
  return null;
}

export type TranslateKind = "post" | "reply" | "message" | "game";
/** The texts translated, in the same order (a post: title, then text). */
export const translate = (kind: TranslateKind, id: string | number, to: Lang) =>
  assist<{ texts: string[] }>({ action: "translate", kind, id, to }).then((r) => r.texts);

export interface SimilarPost {
  id: string;
  kind: "bug" | "idea" | "other";
  title: string;
  vote_count: number;
}
export const similarFeedback = (p: { game_id: string | null; kind: string; title: string; body: string }) =>
  assist<{ posts: SimilarPost[] }>({ action: "similar", ...p }).then((r) => r.posts);

export interface Suggestion {
  id: string;
  slug: string;
  why: string;
}
export const suggestions = (lang: Lang, recent: string[]) => assist<{ games: Suggestion[] }>({ action: "suggest", lang, recent }).then((r) => r.games);

export interface ReleaseDraftInput {
  game_id: string | null;
  notes: string;
  fixes: string[];
  installation_id?: number;
  repo?: string;
  lang: Lang;
}
export const draftRelease = (r: ReleaseDraftInput) =>
  assist<{ title: string; notes: string; commits: number; commitsError: boolean }>({ action: "release", ...r });

export const describeGame = (g: { title: string; category: string; engine: string; controls: string; description: string; description_de: string; play_url: string }) =>
  assist<{ en: string; de: string }>({ action: "describe", ...g });

/** gameId: one game, "toki" (Toki's own board, admins), or null for all the account's games. */
export const summarizeInbox = (gameId: string | null, lang: Lang) => assist<{ text: string }>({ action: "summary", game_id: gameId, lang }).then((r) => r.text);

export type SkipReason = "unclear" | "spam" | "off_topic" | "answered" | "unsafe" | "other";
export interface ImprovePrompt {
  /** the prompt to give to an AI that works on the code; "" when no post was useful */
  prompt: string;
  /** open posts read, and how many of them are in the prompt */
  total: number;
  used: number;
  /** posts left out, and why */
  skipped: { id: string; title: string; why: SkipReason }[];
}
/** gameId: a game, or "toki" for Toki itself (admins). */
export const improvePrompt = (gameId: string, lang: Lang) => assist<ImprovePrompt>({ action: "improve", game_id: gameId, lang });
export const summarizeApplication = (id: string, lang: Lang) => assist<{ text: string }>({ action: "application", id, lang }).then((r) => r.text);

export interface HelpTurn {
  role: "user" | "assistant";
  content: string;
}
/**
 * The game helper's answer to the conversation so far (the last turn is the player's question).
 * progress: the player's save in this game as short text (saveSummary), and when the game made it.
 */
export const askHelper = (gameId: string | null, messages: HelpTurn[], lang: Lang, progress?: { save: string; saved_at: number }) =>
  assist<{ text: string }>({ action: "help", game_id: gameId, messages, lang, ...progress }).then((r) => r.text);

export interface GameHelp {
  notes: string;
  installation_id: number | null;
  repo: string | null;
  guide: string;
  learned_at: string | null;
}
/** What the helper knows about a game (its developer and admins). */
export async function gameHelp(gameId: string): Promise<GameHelp | null> {
  const { data, error } = await supabase.from("game_help").select("notes, installation_id, repo, guide, learned_at").eq("game_id", gameId).maybeSingle();
  if (error) throw error;
  return data as GameHelp | null;
}
/** Saves the tips; with learn, the AI reads the repository again now. */
export const saveGameHelp = (h: { game_id: string; notes: string; installation_id?: number; repo?: string; learn?: boolean }) =>
  assist<{ ok: boolean; learned_at: string | null; guide: string | null }>({ action: "help_setup", ...h });

export interface FreeTest {
  ok: boolean;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
  error?: string;
  message?: string;
}
export const testFreeAi = () => assist<FreeTest>({ action: "test" });

/** Error codes the free features have texts for. */
const ERRORS = ["free_off", "rate_limited", "not_allowed", "nothing_to_write", "github_error", "ai_timeout", "ai_bad_answer", "ai_provider_error", "ai_empty_answer"] as const;
export type AssistError = (typeof ERRORS)[number] | "error";
export const assistError = (e: unknown): AssistError => {
  const code = e instanceof Error ? e.message : "";
  return (ERRORS as readonly string[]).includes(code) ? (code as AssistError) : "error";
};
