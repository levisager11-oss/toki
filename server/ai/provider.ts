// Talking to the AI. One function for every provider, so another one (Anthropic) can be added
// next to the OpenAI-compatible one without changing the code that uses it.

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

export type ProviderName = "openai_compatible";

export interface ProviderConfig {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class AiError extends Error {
  constructor(readonly code: "not_configured" | "provider_error" | "timeout" | "empty_answer", message: string = code) {
    super(message);
  }
}

/** A generous guess of how many tokens a text has (about 3 characters each), so reservations are on the safe side. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export const TIMEOUT_MS = 240_000;

export async function complete(
  config: ProviderConfig,
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<Completion> {
  if (!config.apiKey || !config.baseUrl || !config.model) throw new AiError("not_configured");
  switch (config.provider) {
    case "openai_compatible":
      return openaiCompatible(config, req, fetchImpl);
    default:
      throw new AiError("not_configured", `unknown provider ${String(config.provider)}`);
  }
}

async function openaiCompatible(
  config: ProviderConfig,
  req: { messages: ChatMessage[]; maxTokens: number; temperature?: number },
  fetchImpl: typeof fetch,
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
    throw new AiError("provider_error", "couldn't reach the AI endpoint");
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
