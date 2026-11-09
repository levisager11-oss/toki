// Talking to the AI. One function for every provider (OpenAI-compatible endpoints here, Anthropic in
// anthropic.ts), so the code that uses it doesn't change with the provider.
import { tlsErrorCode, tolerantFetch } from "../tls.js";
import { anthropicComplete, anthropicModels } from "./anthropic.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** true when the endpoint didn't say how many tokens it used, so they were estimated */
  estimated: boolean;
}

export type ProviderName = "openai_compatible" | "anthropic";

export interface ProviderConfig {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class AiError extends Error {
  constructor(
    readonly code: "not_configured" | "provider_error" | "timeout" | "empty_answer" | "refused",
    message: string = code,
    /** The HTTP status when the service answered with an error (it then didn't work on the request). */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The endpoint couldn't be reached; says why when known (e.g. a certificate or DNS problem). */
function unreachable(e: unknown): AiError {
  const code = tlsErrorCode(e);
  return new AiError("provider_error", `couldn't reach the AI endpoint${code ? ` (${code})` : ""}`);
}

/** A generous guess of how many tokens a text has (about 3 characters each), so reservations are on the safe side. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export const TIMEOUT_MS = 240_000;

export async function complete(
  config: ProviderConfig,
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number; timeoutMs?: number },
  fetchImpl?: typeof fetch,
): Promise<Completion> {
  if (!config.apiKey || !config.model || (!config.baseUrl && config.provider !== "anthropic")) throw new AiError("not_configured");
  switch (config.provider) {
    case "openai_compatible":
      return openaiCompatible(config, req, fetchImpl ?? tolerantFetch);
    case "anthropic":
      return anthropicComplete(config, req, fetchImpl);
    default:
      throw new AiError("not_configured", `unknown provider ${String(config.provider)}`);
  }
}

interface OpenAiAnswer {
  choices?: { message?: { content?: string | null }; delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

/** The answer's text, token counts and error, from a JSON answer or a streamed one (server-sent events). */
export function readOpenAiAnswer(raw: string): { text: string; usage: OpenAiAnswer["usage"]; error: string; finish?: string } {
  const errorText = (e: OpenAiAnswer["error"]) => (typeof e === "string" ? e : e?.message ?? "");
  if (!/^\s*(data|event|:)/.test(raw)) {
    let body: OpenAiAnswer = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return { text: "", usage: null, error: raw.slice(0, 300) };
    }
    return { text: body.choices?.[0]?.message?.content ?? "", usage: body.usage, error: errorText(body.error), finish: body.choices?.[0]?.finish_reason ?? undefined };
  }
  let text = "";
  let usage: OpenAiAnswer["usage"] = null;
  let error = "";
  let finish: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || m[1] === "[DONE]") continue;
    let chunk: OpenAiAnswer;
    try {
      chunk = JSON.parse(m[1]);
    } catch {
      continue;
    }
    text += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
    if (chunk.usage) usage = chunk.usage;
    finish = chunk.choices?.[0]?.finish_reason ?? finish;
    if (chunk.error) error = errorText(chunk.error) || "error in the streamed answer";
  }
  return { text, usage, error, finish };
}

// What some endpoints need, learned from their errors, per endpoint and model while this server
// instance runs: min_p set to 0 (see below), no stream_options, or no streaming at all.
const QUIRKS = new Map<string, { zeroMinP?: boolean; noStreamOptions?: boolean; noStream?: boolean }>();

async function openaiCompatible(
  config: ProviderConfig,
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number; timeoutMs?: number },
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Completion> {
  const key = `${config.baseUrl} ${config.model}`;
  const quirks = QUIRKS.get(key) ?? {};
  const send = async () => {
    let res: Response;
    let raw: string;
    try {
      res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          // 0: no limit, the model may use as many tokens as it can (the free AI).
          ...(req.maxTokens > 0 ? { max_tokens: req.maxTokens } : {}),
          temperature: req.temperature ?? 0.2,
          // Streamed, so text keeps arriving while the model writes: proxies in front of some
          // endpoints cut connections that stay quiet for 30 seconds or so.
          ...(quirks.noStream ? {} : { stream: true, ...(quirks.noStreamOptions ? {} : { stream_options: { include_usage: true } }) }),
          ...(quirks.zeroMinP ? { min_p: 0 } : {}),
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
      });
      raw = await res.text();
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new AiError("timeout");
      throw unreachable(e);
    }
    const answer = readOpenAiAnswer(raw);
    // Never pass the key on, in case an endpoint repeats it in an error.
    return { res, answer, error: `${res.status}: ${(answer.error || raw).split(config.apiKey).join("***").slice(0, 300)}` };
  };

  let { res, answer, error } = await send();
  // Some servers (vLLM) fill in a default min_p from the model's settings and then refuse it, e.g.
  // with speculative decoding. They only use that default when the request doesn't say: so ask
  // again with min_p 0. Older servers may not know stream_options. Both are remembered. (Behind
  // LiteLLM, the same refusal can come as a 500 when the answer is streamed.)
  // Last, if a streamed answer fails on the server's side, try once without streaming.
  for (let i = 0; i < 3 && (!res.ok || !!answer.error); i++) {
    if (/min_p/i.test(error) && !quirks.zeroMinP) quirks.zeroMinP = true;
    else if (/stream_options/i.test(error) && !quirks.noStreamOptions) quirks.noStreamOptions = true;
    else if (!quirks.noStream && (res.status >= 500 || /stream/i.test(error))) quirks.noStream = true;
    else break;
    QUIRKS.set(key, quirks);
    ({ res, answer, error } = await send());
  }
  if (!res.ok || (answer.error && !answer.text.trim())) throw new AiError("provider_error", error, res.ok ? undefined : res.status);
  const { text, usage } = answer;
  if (!text.trim()) {
    // Thinking models can use all their tokens for thinking and never get to the answer.
    throw new AiError("empty_answer", answer.finish === "length" ? "The model used all its tokens before writing an answer." : "empty_answer");
  }
  const known = typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";
  return {
    text,
    inputTokens: known ? usage!.prompt_tokens! : estimateTokens(req.messages.map((m) => m.content).join("\n")),
    outputTokens: known ? usage!.completion_tokens! : estimateTokens(text),
    estimated: !known,
  };
}

export interface ModelInfo {
  id: string;
  name?: string;
  /** most tokens the model can take in at once */
  context?: number;
  /** US dollars per million tokens, when the endpoint says (e.g. OpenRouter) */
  inputPrice?: number;
  outputPrice?: number;
}

/** Per-token price as text or number ("0.000003") → dollars per million tokens. */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 10_000) / 10_000 : undefined;
}

/** The models an endpoint offers (GET /models), sorted by name. */
export async function listModels(config: Omit<ProviderConfig, "model">, fetchImpl?: typeof fetch): Promise<ModelInfo[]> {
  if (!config.apiKey) throw new AiError("not_configured");
  if (config.provider === "anthropic") return anthropicModels(config, fetchImpl);
  if (!config.baseUrl) throw new AiError("not_configured");
  let res: Response;
  try {
    res = await (fetchImpl ?? tolerantFetch)(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw unreachable(e);
  }
  const raw = await res.text();
  let body: { data?: unknown; error?: { message?: string } } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* not JSON: reported below */
  }
  if (!res.ok) throw new AiError("provider_error", `${res.status}: ${(body.error?.message ?? raw).slice(0, 200)}`);
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body) ? (body as unknown[]) : [];
  const models: ModelInfo[] = [];
  for (const m of list.slice(0, 5000) as Record<string, unknown>[]) {
    if (!m || typeof m.id !== "string" || !m.id || m.id.length > 200) continue;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const context = Number(m.context_length ?? m.context_window);
    models.push({
      id: m.id,
      name: typeof m.name === "string" && m.name !== m.id ? m.name.slice(0, 200) : undefined,
      context: Number.isFinite(context) && context > 0 ? context : undefined,
      inputPrice: perMillion(pricing.prompt ?? pricing.input),
      outputPrice: perMillion(pricing.completion ?? pricing.output),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
