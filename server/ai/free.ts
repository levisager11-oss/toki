// The free AI: an OpenAI-compatible endpoint where tokens cost nothing (set up on the AI page as
// "Free AI"). No prices or quotas; instead every account may make only so many calls an hour per
// feature (ai_free_take in the database), and calls are counted per day for the admin page.
import type { Db } from "../db.js";
import { AiError, complete, type ChatMessage, type Completion } from "./provider.js";

export type FreeFeature = "translate" | "similar" | "suggest" | "help" | "learn" | "release" | "describe" | "summary" | "connect" | "test";

export interface FreeSettings {
  free_enabled: boolean;
  free_base_url: string;
  free_model: string;
}

export async function freeSettings(db: Db): Promise<FreeSettings | null> {
  const [s] = await db.select<FreeSettings>("ai_settings", "id=eq.1&select=free_enabled,free_base_url,free_model");
  return s?.free_enabled && s.free_base_url && s.free_model ? s : null;
}

export interface FreeCall {
  db: Db;
  /** The key of the OpenAI-compatible endpoint (the same key field as for the strong AI). */
  apiKey: string;
  userId: string;
  feature: FreeFeature;
  messages: ChatMessage[];
  maxTokens: number;
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
  if (!s || !call.apiKey) throw new AiError("not_configured");
  await call.db.rpc("ai_free_take", { p_user: call.userId, p_feature: call.feature });
  const record = (ok: boolean, input: number, output: number) =>
    call.db.rpc("ai_free_record", { p_feature: call.feature, p_ok: ok, p_input_tokens: input, p_output_tokens: output }).catch(() => {});
  try {
    const c = await complete(
      { provider: "openai_compatible", baseUrl: s.free_base_url, model: s.free_model, apiKey: call.apiKey },
      { messages: call.messages, maxTokens: call.maxTokens, temperature: call.temperature, timeoutMs: call.timeoutMs },
      call.fetchImpl,
    );
    await record(true, c.inputTokens, c.outputTokens);
    return c;
  } catch (e) {
    await record(false, 0, 0);
    throw e;
  }
}
