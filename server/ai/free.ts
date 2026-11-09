// The free AI: an OpenAI-compatible endpoint where tokens cost nothing (set up on the AI page as
// "Free AI"). No token limit is sent, so the model may answer as long as it can. No prices or quotas; instead every account may make only so many calls an hour per
// feature (ai_free_take in the database), and calls are counted per day for the admin page.
import type { Db } from "../db.js";
import { AiError, complete, type ChatMessage, type Completion, type Thinking } from "./provider.js";

export type FreeFeature = "translate" | "similar" | "suggest" | "help" | "learn" | "release" | "describe" | "summary" | "connect" | "test";

export interface FreeSettings {
  /** the strong AI's provider and address, to tell whether its key may be used here */
  provider: string;
  base_url: string;
  free_enabled: boolean;
  free_base_url: string;
  free_model: string;
  free_thinking: Thinking;
}

export async function freeSettings(db: Db): Promise<FreeSettings | null> {
  const [s] = await db.select<FreeSettings>("ai_settings", "id=eq.1&select=provider,base_url,free_enabled,free_base_url,free_model,free_thinking");
  return s?.free_enabled && s.free_base_url && s.free_model ? s : null;
}

export interface FreeCall {
  db: Db;
  /** The free AI's own key, and the strong AI's OpenAI-compatible key (used only when safe). */
  keys: { free: string; openai: string };
  userId: string;
  feature: FreeFeature;
  messages: ChatMessage[];
  temperature?: number;
  /** Gives up after this long (the free features' server requests have a minute). */
  timeoutMs?: number;
  /** Settings already read (e.g. by Toki Connect), so they aren't read again. */
  settings?: FreeSettings | null;
  fetchImpl?: typeof fetch;
}

/** Raises DbError("free_off" | "not_allowed" | "rate_limited") or AiError. */
export async function freeCompletion(call: FreeCall): Promise<Completion> {
  const s = call.settings === undefined ? await freeSettings(call.db) : call.settings;
  const apiKey = s ? freeKey(call.keys, s) : "";
  if (!s || !apiKey) throw new AiError("not_configured", s ? "The free AI needs its own key: its endpoint isn't the strong AI's." : "not_configured");
  await call.db.rpc("ai_free_take", { p_user: call.userId, p_feature: call.feature });
  const record = (ok: boolean, input: number, output: number) =>
    call.db.rpc("ai_free_record", { p_feature: call.feature, p_ok: ok, p_input_tokens: input, p_output_tokens: output }).catch(() => {});
  try {
    const c = await complete(
      { provider: "openai_compatible", baseUrl: s.free_base_url, model: s.free_model, apiKey, thinking: s.free_thinking },
      { messages: call.messages, maxTokens: 0, temperature: call.temperature, timeoutMs: call.timeoutMs },
      call.fetchImpl,
    );
    await record(true, c.inputTokens, c.outputTokens);
    return c;
  } catch (e) {
    await record(false, 0, 0);
    throw e;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The key for the free AI: its own, or else the OpenAI-compatible key, but that one only when it
 * can't reach another service: the strong AI isn't OpenAI-compatible (so the key is the free
 * endpoint's), or it's the same endpoint.
 */
export function freeKey(keys: { free: string; openai: string }, s: Pick<FreeSettings, "provider" | "base_url" | "free_base_url">): string {
  if (keys.free) return keys.free;
  if (s.provider !== "openai_compatible" || (host(s.base_url) && host(s.base_url) === host(s.free_base_url))) return keys.openai;
  return "";
}
