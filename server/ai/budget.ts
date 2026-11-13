// Every AI call goes through here: reserve the highest possible cost (stops at the feature's calls
// per hour, the developer's quota and Toki's monthly cap), call the feature's model, then settle
// the real cost.
import type { Db } from "../db.js";
import { AiError, complete, estimateTokens, type ChatMessage, type Completion, type ProviderName, type Thinking } from "./provider.js";

/** The AI features; each has its own model in ai_features (an empty model turns it off). */
export const AI_FEATURES = [
  "translate", "similar", "suggest", "help", "learn", "release", "describe", "summary", "connect", "connect_steps", "connect_quick",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Whether a feature has a model (and the AI is on). */
export async function featureOn(db: Db, feature: AiFeature): Promise<boolean> {
  const [s] = await db.select<{ enabled: boolean }>("ai_settings", "id=eq.1&select=enabled");
  if (!s?.enabled) return false;
  const [f] = await db.select<{ model: string }>("ai_features", `feature=eq.${feature}&select=model`);
  return !!f?.model;
}

interface Reservation {
  id: number;
  provider: ProviderName;
  base_url: string;
  model: string;
  thinking?: Thinking;
  max_cost: number;
}

export interface BudgetedCall {
  db: Db;
  /** The key for each provider; the one for the provider in the settings is used. */
  keys: Record<ProviderName, string>;
  userId: string;
  feature: AiFeature | "test";
  /** For "test" (admins): the feature whose model is tried. */
  testFeature?: AiFeature;
  jobId?: string | null;
  messages: ChatMessage[];
  maxTokens: number;
  /** Think less than the settings say (when the last answer ran out of tokens while thinking). */
  thinking?: Thinking;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Raises DbError("ai_disabled" | "ai_off" | "not_allowed" | "rate_limited" | "cap_reached" | "quota_reached") or AiError. */
export async function budgetedCompletion(call: BudgetedCall): Promise<Completion & { cost: number }> {
  if (!Object.values(call.keys).some(Boolean)) throw new AiError("not_configured");
  // Each message also costs a few tokens of its own.
  const inputTokens = estimateTokens(call.messages.map((m) => m.content).join("\n")) + 10 * call.messages.length;
  const r = await call.db.rpc<Reservation>("ai_reserve", {
    p_user: call.userId,
    p_feature: call.feature,
    p_job: call.jobId ?? null,
    p_input_tokens: inputTokens,
    p_max_output_tokens: call.maxTokens,
    p_test_feature: call.testFeature ?? null,
  });
  let result: Completion;
  try {
    result = await complete({ provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: call.keys[r.provider] ?? "", thinking: call.thinking ?? r.thinking }, { messages: call.messages, maxTokens: call.maxTokens, temperature: call.temperature, timeoutMs: call.timeoutMs }, call.fetchImpl);
  } catch (e) {
    // A request the service refused with an error status wasn't worked on. Otherwise (e.g. the
    // connection broke) the service may have charged for reading it: count that, on the safe side.
    const refused = e instanceof AiError && (e.code === "not_configured" || e.status !== undefined);
    const spent = e instanceof AiError ? Math.min(e.outputTokens ?? 0, call.maxTokens) : 0;
    await call.db.rpc("ai_settle", { p_id: r.id, p_input_tokens: refused ? 0 : inputTokens, p_output_tokens: spent, p_ok: false }).catch(() => {});
    // Why it failed, for the admin page.
    const why = e instanceof AiError ? (e.message === e.code ? e.code : `${e.code}: ${e.message}`) : "error";
    await Promise.resolve()
      .then(() => call.db.update("ai_usage", `id=eq.${r.id}`, { error: why.slice(0, 500) }))
      .catch(() => {});
    throw e;
  }
  const cost = await call.db.rpc<number | null>("ai_settle", { p_id: r.id, p_input_tokens: result.inputTokens, p_output_tokens: result.outputTokens, p_ok: true });
  return { ...result, cost: Number(cost ?? r.max_cost) };
}
