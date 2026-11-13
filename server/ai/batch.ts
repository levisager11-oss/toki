// AI calls nobody has to wait for, through Anthropic's Message Batches API: half the price, and
// the answer comes within minutes (at most a day). The call's highest cost is reserved like any
// other call (ai_reserve); when the answer is collected, half its real cost is settled.
import type { Db } from "../db.js";
import { anthropicRequest, asAiError, client, textOf, usageOf } from "./anthropic.js";
import { reserve, type BudgetedCall } from "./budget.js";
import { AiError } from "./provider.js";

/** A batch older than this has expired on Anthropic's side (24 hours) or never will finish. */
const GIVE_UP_MS = 25 * 3600_000;

export interface StartedBatch {
  /** the reservation in ai_usage */
  usageId: number;
  batchId: string;
}

/** Starts one call as a batch. Raises the budget's DbErrors, or AiError when Anthropic refused it. */
export async function budgetedBatch(call: Omit<BudgetedCall, "onText" | "timeoutMs">): Promise<StartedBatch> {
  const { reservation: r } = await reserve(call);
  const apiKey = call.keys.anthropic;
  try {
    const params = anthropicRequest({ model: r.model, thinking: call.thinking ?? r.thinking }, { messages: call.messages, maxTokens: call.maxTokens, schema: call.schema });
    const batch = await client({ baseUrl: r.base_url, apiKey }, call.fetchImpl, 30_000).messages.batches.create({
      requests: [{ custom_id: `toki-${r.id}`, params }],
    });
    return { usageId: r.id, batchId: batch.id };
  } catch (e) {
    // Not started: nothing was charged.
    await call.db.rpc("ai_settle", { p_id: r.id, p_input_tokens: 0, p_output_tokens: 0, p_ok: false }).catch(() => {});
    const err = asAiError(e);
    await call.db.update("ai_usage", `id=eq.${r.id}`, { error: `batch: ${err.code}: ${err.message}`.slice(0, 500) }).catch(() => {});
    throw err;
  }
}

export type BatchResult =
  | { state: "waiting" }
  | { state: "done"; text: string; cost: number }
  | { state: "failed"; error: string };

/**
 * Looks at a batch once. When it has ended, settles the reservation (half the real price on
 * success, nothing when Anthropic couldn't answer) and returns the answer.
 */
export async function collectBatch(
  db: Db,
  apiKey: string,
  b: StartedBatch & { startedAt: string | number },
  fetchImpl?: typeof fetch,
): Promise<BatchResult> {
  if (!apiKey) return { state: "waiting" };
  const [s] = await db.select<{ base_url: string }>("ai_settings", "id=eq.1&select=base_url");
  const c = client({ baseUrl: s?.base_url ?? "", apiKey }, fetchImpl, 30_000);
  const settle = async (ok: boolean, cost: number, tokens: { inputTokens: number; outputTokens: number } | null, error?: string) => {
    await db.rpc("ai_settle_amount", { p_id: b.usageId, p_cost: cost, p_ok: ok }).catch(() => {});
    const patch: Record<string, unknown> = {};
    if (tokens) Object.assign(patch, { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens });
    if (error) patch.error = error.slice(0, 500);
    if (Object.keys(patch).length) await db.update("ai_usage", `id=eq.${b.usageId}`, patch).catch(() => {});
  };
  try {
    const batch = await c.messages.batches.retrieve(b.batchId);
    if (batch.processing_status !== "ended") {
      if (Date.now() - new Date(b.startedAt).getTime() < GIVE_UP_MS) return { state: "waiting" };
      await c.messages.batches.cancel(b.batchId).catch(() => {});
      await settle(false, 0, null, "batch: expired");
      return { state: "failed", error: "ai_timeout" };
    }
    for await (const item of await c.messages.batches.results(b.batchId)) {
      const res = item.result;
      if (res.type !== "succeeded") {
        const why = res.type === "errored" ? `${res.error?.error?.type ?? "error"}: ${res.error?.error?.message ?? ""}` : res.type;
        await settle(false, 0, null, `batch: ${why}`);
        return { state: "failed", error: res.type === "expired" ? "ai_timeout" : "ai_provider_error" };
      }
      const msg = res.message;
      const used = usageOf(msg.usage);
      const [row] = await db.select<{ input_price: number; output_price: number }>("ai_usage", `id=eq.${b.usageId}&select=input_price,output_price`);
      // Batches cost half the list price.
      const cost = row ? (0.5 * (used.inputTokens * Number(row.input_price) + used.outputTokens * Number(row.output_price))) / 1_000_000 : 0;
      const text = textOf(msg.content);
      if (msg.stop_reason === "refusal" || !text.trim()) {
        await settle(false, cost, used, msg.stop_reason === "refusal" ? "refused" : "empty_answer");
        return { state: "failed", error: msg.stop_reason === "refusal" ? "ai_refused" : "ai_empty_answer" };
      }
      await settle(true, cost, used);
      return { state: "done", text, cost };
    }
    await settle(false, 0, null, "batch: no result");
    return { state: "failed", error: "ai_empty_answer" };
  } catch (e) {
    // Anthropic couldn't be asked right now: try again next time.
    const err = asAiError(e);
    if (err.code === "bad_key" || (err.status === 404 && Date.now() - new Date(b.startedAt).getTime() > 3600_000)) {
      await settle(false, 0, null, `batch: ${err.code}: ${err.message}`);
      return { state: "failed", error: `ai_${err.code}` };
    }
    if (err instanceof AiError) return { state: "waiting" };
    throw e;
  }
}
