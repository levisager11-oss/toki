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
export const WITH_FALLBACK = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

interface Config {
  baseUrl: string;
  apiKey: string;
}

export function client(config: Config, fetchImpl?: typeof fetch, timeoutMs = TIMEOUT_MS) {
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || ANTHROPIC_URL,
    timeout: timeoutMs,
    // The SDK waits and tries again when Anthropic is busy (429, 529) or the connection breaks.
    // Long calls get one retry only, so they still end within the function's 5 minutes.
    maxRetries: timeoutMs <= 120_000 ? 2 : 1,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** Anthropic's error, as one of Toki's codes (the admin page and the buttons explain each). */
export function asAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiError("timeout");
  if (e instanceof Anthropic.AuthenticationError) return new AiError("bad_key", "Anthropic doesn't accept this API key.", 401);
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError("bad_key", `403: ${e.message}`.slice(0, 300), 403);
  if (e instanceof Anthropic.RateLimitError) return new AiError("busy", `429: ${e.message}`.slice(0, 300), 429);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? undefined;
    // "Your credit balance is too low to access the Anthropic API": the account needs credits.
    if (status === 400 && /credit balance|billing|purchase credits/i.test(e.message)) return new AiError("no_credit", e.message.slice(0, 300), 400);
    // 529: Anthropic is overloaded (the SDK already waited and tried again).
    if (status === 529 || status === 503 || /overloaded/i.test(e.message)) return new AiError("busy", `${status ?? ""}: ${e.message}`.slice(0, 300), status);
    return new AiError("provider_error", `${status ?? ""}: ${e.message}`.slice(0, 300), status);
  }
  if (e instanceof Anthropic.APIConnectionError) return new AiError("provider_error", "couldn't reach the Anthropic API");
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

/** The request for Toki's messages: system parts apart, cache breakpoints where marked. */
export function anthropicRequest(
  config: { model: string; thinking?: Thinking },
  req: { messages: ChatMessage[]; maxTokens: number; schema?: Record<string, unknown> },
  opts: { effort?: boolean; format?: boolean; late?: boolean } = {},
) {
  // Parts marked "cache" get a cache breakpoint: the next call with the same beginning reads them
  // from the cache at a tenth of the price. (Consecutive user messages become one turn.)
  const cacheControl = { type: "ephemeral" as const };
  // "late" system messages stay in the conversation (models that can't take them get them with
  // the other instructions instead).
  const inPlace = (m: ChatMessage) => m.role === "system" && !!m.late && opts.late !== false;
  const system: TextBlockParam[] = req.messages
    .filter((m) => m.role === "system" && !inPlace(m))
    .map((m) => ({ type: "text", text: m.content, ...(m.cache ? { cache_control: cacheControl } : {}) }));
  const messages = req.messages
    .filter((m) => m.role !== "system" || inPlace(m))
    .map((m) =>
      m.role === "system"
        ? { role: "system" as const, content: m.content }
        : { role: m.role, content: [{ type: "text" as const, text: m.content, ...(m.cache ? { cache_control: cacheControl } : {}) }] },
    ) as MessageParam[];
  const effort = opts.effort === false ? null : effortFor(config.thinking);
  // Structured outputs: the answer is always valid JSON of this shape.
  const format = opts.format !== false && req.schema ? { type: "json_schema" as const, schema: req.schema } : null;
  const outputConfig = { ...(effort ? { effort } : {}), ...(format ? { format } : {}) };
  return {
    model: config.model,
    max_tokens: req.maxTokens,
    messages,
    ...(system.length ? { system } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

/** Tokens in what they cost: writing to the cache costs 1.25 times the input price, reading 0.1 times. */
function costTokens(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  return {
    input: (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
  };
}

/**
 * Tokens of the whole call. With a server-side fallback the top-level usage is only the attempt
 * that answered; usage.iterations has every attempt (a declined one may have been billed too).
 */
export function usageOf(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = (usage ?? {}) as Parameters<typeof costTokens>[0] & { iterations?: (Parameters<typeof costTokens>[0] & { type?: string })[] | null };
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations.filter((i) => i.type !== "compaction") : [u];
  const sum = parts.map(costTokens).reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output }), { input: 0, output: 0 });
  return { inputTokens: Math.ceil(sum.input), outputTokens: sum.output };
}

/** The answer's text: only text blocks (thinking and fallback markers aren't part of it). */
export function textOf(content: unknown): string {
  return ((content ?? []) as { type: string; text?: string }[]).map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

/** Errors that mean "this model doesn't know that part of the request": ask again without it. */
const unknownEffort = (e: unknown) => e instanceof Anthropic.BadRequestError && /effort/i.test(e.message);
const unknownFormat = (e: unknown) => e instanceof Anthropic.BadRequestError && /output_config\.format|json_schema|structured output|output format/i.test(e.message);
const unknownFallback = (e: unknown) => e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message);
const unknownLateSystem = (e: unknown) => e instanceof Anthropic.BadRequestError && /role.{0,4}system|system.{0,20}not supported/i.test(e.message);

export async function anthropicComplete(
  config: Config & { model: string; thinking?: Thinking },
  req: { messages: ChatMessage[]; maxTokens: number; timeoutMs?: number; schema?: Record<string, unknown>; onText?: (delta: string) => void },
  fetchImpl?: typeof fetch,
): Promise<Completion> {
  const c = client(config, fetchImpl, req.timeoutMs);
  const opts = { effort: true, format: true, late: true, fallback: WITH_FALLBACK.has(config.model) };
  // Streamed, because requests can be large and take a while (and "Ask AI" shows the words as they come).
  const send = async () => {
    const base = anthropicRequest(config, req, opts);
    const onText = (delta: string) => req.onText?.(delta);
    if (opts.fallback) {
      const stream = c.beta.messages.stream({ ...base, betas: [FALLBACK_BETA], fallbacks: "default" });
      if (req.onText) stream.on("text", onText);
      return stream.finalMessage();
    }
    const stream = c.messages.stream(base);
    if (req.onText) stream.on("text", onText);
    return stream.finalMessage();
  };
  try {
    let msg: Awaited<ReturnType<typeof send>> | undefined;
    // Older models don't know effort or structured outputs, and an address other than Anthropic's
    // may not know the fallback: ask again without what the error names (each at most once).
    for (let i = 0; i < 5 && !msg; i++) {
      try {
        msg = await send();
      } catch (e) {
        if (opts.late && unknownLateSystem(e) && req.messages.some((m) => m.late)) opts.late = false;
        else if (opts.effort && unknownEffort(e)) opts.effort = false;
        else if (opts.format && req.schema && unknownFormat(e)) opts.format = false;
        else if (opts.fallback && unknownFallback(e)) opts.fallback = false;
        else throw e;
      }
    }
    if (!msg) throw new AiError("provider_error");
    const used = usageOf(msg.usage);
    // A refusal can come after part of an answer: that part is no answer.
    if (msg.stop_reason === "refusal") throw new AiError("refused", "refused", undefined, used.outputTokens);
    const text = textOf(msg.content);
    if (!text.trim()) {
      if (msg.stop_reason === "max_tokens") throw new AiError("empty_answer", "The model used all its tokens before writing an answer.", undefined, used.outputTokens);
      throw new AiError("empty_answer");
    }
    return { text, ...used, estimated: false, truncated: msg.stop_reason === "max_tokens" };
  } catch (e) {
    throw asAiError(e);
  }
}

/** Checks a key without spending anything (the Models API is free). */
export async function anthropicCheckKey(config: Config, fetchImpl?: typeof fetch): Promise<{ models: number }> {
  try {
    const page = await client(config, fetchImpl, 20_000).models.list({ limit: 100 });
    return { models: page.data.length };
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
