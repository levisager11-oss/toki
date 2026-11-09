// Every AI call goes through here: reserve the highest possible cost (stops at the developer's
// quota and Toki's monthly cap), call the AI, then settle the real cost.
import type { Db } from "../db.js";
import { AiError, complete, estimateTokens, type ChatMessage, type Completion, type ProviderName } from "./provider.js";

interface Reservation {
  id: number;
  provider: ProviderName;
  base_url: string;
  model: string;
  max_cost: number;
}

export interface BudgetedCall {
  db: Db;
  /** The key for each provider; the one for the provider in the settings is used. */
  keys: Record<ProviderName, string>;
  userId: string;
  feature: "connect" | "test";
  jobId?: string | null;
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
}

/** Raises DbError("ai_disabled" | "not_allowed" | "cap_reached" | "quota_reached") or AiError. */
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
  });
  let result: Completion;
  try {
    result = await complete({ provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: call.keys[r.provider] ?? "" }, { messages: call.messages, maxTokens: call.maxTokens }, call.fetchImpl);
  } catch (e) {
    // The endpoint may have charged for reading the request: count it, on the safe side.
    const tokens = e instanceof AiError && e.code === "not_configured" ? 0 : inputTokens;
    await call.db.rpc("ai_settle", { p_id: r.id, p_input_tokens: tokens, p_output_tokens: 0, p_ok: false }).catch(() => {});
    throw e;
  }
  const cost = await call.db.rpc<number | null>("ai_settle", { p_id: r.id, p_input_tokens: result.inputTokens, p_output_tokens: result.outputTokens, p_ok: true });
  return { ...result, cost: Number(cost ?? r.max_cost) };
}
