// Anthropic (Claude) as AI provider, through the official SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AiError, TIMEOUT_MS, type ChatMessage, type Completion, type ModelInfo } from "./provider.js";

export const ANTHROPIC_URL = "https://api.anthropic.com";

/** List prices (US dollars per million tokens), so the admin page can fill them in; the Models API has none. */
export const CLAUDE_PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// On these models, when safety checks decline a request, Anthropic answers it with a fitting
// other model instead (server-side fallback), in the same call.
const WITH_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

interface Config {
  baseUrl: string;
  apiKey: string;
}

function client(config: Config, fetchImpl?: typeof fetch) {
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || ANTHROPIC_URL,
    timeout: TIMEOUT_MS,
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

export async function anthropicComplete(
  config: Config & { model: string },
  req: { messages: ChatMessage[]; maxTokens: number },
  fetchImpl?: typeof fetch,
): Promise<Completion> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const messages: MessageParam[] = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const base = { model: config.model, max_tokens: req.maxTokens, messages, ...(system ? { system } : {}) };
  try {
    const c = client(config, fetchImpl);
    // Streamed, because requests can be large and take a while.
    const msg = WITH_FALLBACK.has(config.model)
      ? await c.beta.messages.stream({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage()
      : await c.messages.stream(base).finalMessage();
    if (msg.stop_reason === "refusal") throw new AiError("refused");
    // Only the answer's text blocks; thinking blocks aren't part of the answer.
    const blocks = msg.content as { type: string; text?: string }[];
    const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
    if (!text.trim()) throw new AiError("empty_answer");
    const u = msg.usage;
    return {
      text,
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
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
