// Anthropic (Claude) as AI provider, through the official SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { AiError, TIMEOUT_MS, type ChatMessage, type Completion, type ModelInfo, type Thinking } from "./provider.js";

export const ANTHROPIC_URL = "https://api.anthropic.com";

// List prices (US dollars per million tokens), so the admin page can fill them in; the Models API has none.
export { CLAUDE_PRICES } from "../../src/lib/claudeModels.js";
import { CLAUDE_PRICES } from "../../src/lib/claudeModels.js";

// On these models, when safety checks decline a request, Anthropic answers it with a fitting
// other model instead (server-side fallback), in the same call.
const WITH_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

interface Config {
  baseUrl: string;
  apiKey: string;
}

function client(config: Config, fetchImpl?: typeof fetch, timeoutMs = TIMEOUT_MS) {
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || ANTHROPIC_URL,
    timeout: timeoutMs,
    maxRetries: 1,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function asAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError("timeout");
  if (e instanceof Anthropic.APIError) return new AiError("provider_error", `${e.status ?? ""}: ${e.message}`.slice(0, 300), e.status ?? undefined);
  return new AiError("provider_error", "couldn't reach the Anthropic API");
}

/**
 * The thinking level as Anthropic's effort. The newest Claude models can't turn thinking off, so
 * "off" asks for the least ("low"); "default" leaves it to the model.
 */
export function effortFor(thinking: Thinking | undefined): "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (!thinking || thinking === "default") return null;
  return thinking === "off" ? "low" : thinking;
}

export async function anthropicComplete(
  config: Config & { model: string; thinking?: Thinking },
  req: { messages: ChatMessage[]; maxTokens: number; timeoutMs?: number },
  fetchImpl?: typeof fetch,
): Promise<Completion> {
  // Parts marked "cache" get a cache breakpoint: the next call with the same beginning reads them
  // from the cache at a tenth of the price. (Consecutive user messages become one turn.)
  const cacheControl = { type: "ephemeral" as const };
  const systemParts = req.messages.filter((m) => m.role === "system");
  const system: TextBlockParam[] = systemParts.map((m) => ({ type: "text", text: m.content, ...(m.cache ? { cache_control: cacheControl } : {}) }));
  const messages: MessageParam[] = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: [{ type: "text", text: m.content, ...(m.cache ? { cache_control: cacheControl } : {}) }] }));
  const effort = effortFor(config.thinking);
  const plain = { model: config.model, max_tokens: req.maxTokens, messages, ...(system.length ? { system } : {}) };
  try {
    const c = client(config, fetchImpl, req.timeoutMs);
    // Streamed, because requests can be large and take a while.
    const send = (withEffort: boolean) => {
      const base = { ...plain, ...(withEffort && effort ? { output_config: { effort } } : {}) };
      return WITH_FALLBACK.has(config.model)
        ? c.beta.messages.stream({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage()
        : c.messages.stream(base).finalMessage();
    };
    let msg;
    try {
      msg = await send(true);
    } catch (e) {
      // Older models (e.g. Haiku 4.5) don't know effort: ask again without it.
      if (!effort || !(e instanceof Anthropic.BadRequestError) || !/effort|output_config/i.test(e.message)) throw e;
      msg = await send(false);
    }
    if (msg.stop_reason === "refusal") throw new AiError("refused");
    // Only the answer's text blocks; thinking blocks aren't part of the answer.
    const blocks = msg.content as { type: string; text?: string }[];
    const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
    if (!text.trim()) throw new AiError("empty_answer");
    const u = msg.usage;
    return {
      text,
      // In what they cost: writing to the cache costs 1.25 times the input price, reading 0.1 times.
      inputTokens: Math.ceil(u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)),
      outputTokens: u.output_tokens,
      estimated: false,
    };
  } catch (e) {
    throw asAiError(e);
  }
}

export async function anthropicModels(config: Config, fetchImpl?: typeof fetch): Promise<ModelInfo[]> {
  try {
    const models: ModelInfo[] = [];
    for await (const m of client(config, fetchImpl).models.list({ limit: 100 })) {
      const price = CLAUDE_PRICES[m.id];
      models.push({
        id: m.id,
        name: m.display_name !== m.id ? m.display_name : undefined,
        context: m.max_input_tokens ?? undefined,
        inputPrice: price?.input,
        outputPrice: price?.output,
      });
      if (models.length >= 1000) break;
    }
    return models;
  } catch (e) {
    throw asAiError(e);
  }
}
