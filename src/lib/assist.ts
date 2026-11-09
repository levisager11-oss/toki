// The free AI's small helpers for the pages (the AI itself runs on the server, api/assist.ts).
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { api } from "./ai";

export type Lang = "en" | "de";

let freeOn: Promise<boolean> | null = null;
/** Whether the free AI features are on (asked once per visit). */
export function useFreeAi(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    freeOn ??= Promise.resolve(supabase.rpc("ai_free_on")).then(({ data, error }) => !error && data === true, () => false);
    freeOn.then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, []);
  return on;
}

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
export const summarizeApplication = (id: string, lang: Lang) => assist<{ text: string }>({ action: "application", id, lang }).then((r) => r.text);

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
const ERRORS = ["free_off", "rate_limited", "not_allowed", "nothing_to_write", "ai_timeout", "ai_bad_answer", "ai_provider_error", "ai_empty_answer"] as const;
export type AssistError = (typeof ERRORS)[number] | "error";
export const assistError = (e: unknown): AssistError => {
  const code = e instanceof Error ? e.message : "";
  return (ERRORS as readonly string[]).includes(code) ? (code as AssistError) : "error";
};
