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
  constructor(readonly code: "not_configured" | "provider_error" | "timeout" | "empty_answer" | "refused", message: string = code) {
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
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number },
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

async function openaiCompatible(
  config: ProviderConfig,
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number },
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Completion> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: req.messages, max_tokens: req.maxTokens, temperature: req.temperature ?? 0.2 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new AiError("timeout");
    throw unreachable(e);
  }
  const raw = await res.text();
  let body: {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* not JSON: reported below */
  }
  if (!res.ok) throw new AiError("provider_error", `${res.status}: ${(body.error?.message ?? raw).slice(0, 200)}`);
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new AiError("empty_answer");
  const known = typeof body.usage?.prompt_tokens === "number" && typeof body.usage?.completion_tokens === "number";
  return {
    text,
    inputTokens: known ? body.usage!.prompt_tokens! : estimateTokens(req.messages.map((m) => m.content).join("\n")),
    outputTokens: known ? body.usage!.completion_tokens! : estimateTokens(text),
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
