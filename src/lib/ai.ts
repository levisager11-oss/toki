// AI settings and spending (admins) and Toki Connect (developers) for the pages.
// The AI itself only runs on the server (api/ai.ts, api/github.ts, api/connect.ts).
import { supabase } from "./supabase";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${data.session?.access_token ?? ""}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof body?.error === "string" ? body.error : "error", typeof body?.message === "string" ? body.message : "");
  return body as T;
}

export class ApiError extends Error {
  /** The server's explanation, when it gave one (e.g. what the AI endpoint answered). */
  constructor(code: string, readonly detail = "") {
    super(code);
  }
}

/** "$1.23", or more digits for amounts below a cent. */
export function usd(n: number): string {
  const v = Number(n) || 0;
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

// ---------- admins ----------

export type Provider = "openai_compatible" | "anthropic";
export const OUTPUT_LIMITS = [8000, 16000, 32000, 64000, 128000] as const;
export const THINKING = ["default", "off", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];

export interface AiSettings {
  enabled: boolean;
  provider: Provider;
  base_url: string;
  model: string;
  input_price: number;
  output_price: number;
  monthly_cap: number;
  default_quota: number;
  /** how much the strong AI may think (Anthropic: effort) */
  thinking: Thinking;
  /** most tokens the strong AI may write per Toki Connect step, thinking included */
  max_output_tokens: number;
  /** Toki Connect with Claude Managed Agents (Anthropic only), and its cap per run in US dollars */
  agent_enabled: boolean;
  agent_budget: number;
  /** the free AI (an OpenAI-compatible endpoint, no prices or quotas) */
  free_enabled: boolean;
  free_base_url: string;
  free_model: string;
  /** how much the free AI may think before answering */
  free_thinking: Thinking;
  /** Toki Connect lets the free AI do the easy steps */
  connect_free_steps: boolean;
  /** one-click add: which AI adds leaderboard code */
  quick_code_ai: "free" | "strong" | "off";
  updated_at: string;
}

export async function getAiSettings(): Promise<AiSettings> {
  const { data, error } = await supabase.from("ai_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  const s = data as Record<string, unknown>;
  // numeric columns come back as text
  for (const k of ["input_price", "output_price", "monthly_cap", "default_quota", "agent_budget"]) s[k] = Number(s[k]);
  return s as unknown as AiSettings;
}

export type SettingsChange = Partial<
  Pick<AiSettings, "enabled" | "provider" | "base_url" | "model" | "input_price" | "output_price" | "monthly_cap" | "default_quota" | "thinking" | "max_output_tokens" | "agent_enabled" | "agent_budget" | "free_enabled" | "free_base_url" | "free_model" | "free_thinking" | "connect_free_steps" | "quick_code_ai">
>;

export interface FreeUsage {
  feature: string;
  calls: number;
  failed: number;
  tokens: number;
}

/** The free AI's calls in the last 7 days, per feature (admins). */
export async function freeUsage(): Promise<FreeUsage[]> {
  const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("ai_free_usage").select("feature, calls, failed, input_tokens, output_tokens").gte("day", since);
  if (error) throw error;
  const by = new Map<string, FreeUsage>();
  for (const r of data as { feature: string; calls: number; failed: number; input_tokens: number; output_tokens: number }[]) {
    const u = by.get(r.feature) ?? { feature: r.feature, calls: 0, failed: 0, tokens: 0 };
    u.calls += r.calls;
    u.failed += r.failed;
    u.tokens += Number(r.input_tokens) + Number(r.output_tokens);
    by.set(r.feature, u);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls);
}

export async function saveAiSettings(change: SettingsChange): Promise<void> {
  const { error } = await supabase.from("ai_settings").update(change).eq("id", 1);
  if (error) throw error;
}

export interface AiStatus {
  aiKey: boolean;
  /** "env": set in Vercel's settings; "toki": set up on this page */
  aiKeySource: "env" | "toki" | null;
  anthropicKey: boolean;
  anthropicKeySource: "env" | "toki" | null;
  /** the free AI's own key (optional) */
  freeAiKey: boolean;
  freeAiKeySource: "env" | "toki" | null;
  serviceKey: boolean;
  github: boolean;
  githubSource: "env" | "toki" | null;
  githubSlug: string | null;
}

/** Which secret keys are set on the server. Fails with "not_configured" when the Supabase key is missing. */
export const aiStatus = () => api<AiStatus>("/api/ai");

export interface TestResult {
  ok: boolean;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
  cost?: number;
  error?: string;
  message?: string;
}

const aiAction = <T = { ok: boolean }>(body: Record<string, unknown>) => api<T>("/api/ai", { method: "POST", body: JSON.stringify(body) });
/** Stored encrypted on the server; it can't be read back. */
/** "free": the free AI's own key. */
export const setAiKey = (key: string, provider: Provider | "free") => aiAction({ action: "set_ai_key", key, provider });
export const clearAiKey = (provider: Provider | "free") => aiAction({ action: "clear_ai_key", provider });
export const githubFromManifest = (code: string) => aiAction<{ ok: boolean; slug: string; htmlUrl: string }>({ action: "github_manifest", code });
export const clearGithubApp = () => aiAction({ action: "clear_github" });

const APP_STATE = "toki.githubAppState";
/** Sends the admin to GitHub with the app already filled in; GitHub sends them back with a code. */
export function createGithubApp(manifest: object) {
  const state = crypto.randomUUID();
  try {
    sessionStorage.setItem(APP_STATE, state);
  } catch {
    /* the check on return then fails and asks to try again */
  }
  const form = document.createElement("form");
  form.method = "post";
  form.action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}
export function githubAppStateMatches(state: string | null): boolean {
  try {
    const saved = sessionStorage.getItem(APP_STATE);
    sessionStorage.removeItem(APP_STATE);
    return !!state && state === saved;
  } catch {
    return false;
  }
}

export const testAi = () => api<TestResult>("/api/ai", { method: "POST", body: JSON.stringify({ action: "test" }) });

export interface Overview {
  month_start: string;
  spent: number;
  reserved: number;
  calls: number;
  users: { user_id: string | null; username: string | null; role: string | null; spent: number; calls: number; quota: number | null }[];
}

export async function monthOverview(): Promise<Overview> {
  const { data, error } = await supabase.rpc("ai_month_overview");
  if (error) throw error;
  return data as Overview;
}

export interface UsageRow {
  id: number;
  feature: "connect" | "test";
  model: string;
  status: "reserved" | "done" | "failed";
  input_tokens: number;
  output_tokens: number;
  cost: number;
  /** why a failed call failed */
  error: string | null;
  created_at: string;
  user: { username: string } | null;
}

export async function recentUsage(): Promise<UsageRow[]> {
  const { data, error } = await supabase
    .from("ai_usage")
    .select("id, feature, model, status, input_tokens, output_tokens, cost, error, created_at, user:profiles!ai_usage_user_id_fkey(username)")
    .order("id", { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data as unknown as UsageRow[]).map((r) => ({ ...r, cost: Number(r.cost) }));
}

export async function developersWithQuotas(): Promise<{ id: string; username: string; role: string; quota: number | null }[]> {
  const [{ data: people, error: e1 }, { data: quotas, error: e2 }] = await Promise.all([
    supabase.from("profiles").select("id, username, role").in("role", ["creator"]).order("username"),
    supabase.from("ai_quotas").select("user_id, monthly_usd"),
  ]);
  if (e1 || e2) throw e1 ?? e2;
  const q = new Map((quotas as { user_id: string; monthly_usd: string }[]).map((x) => [x.user_id, Number(x.monthly_usd)]));
  return (people as { id: string; username: string; role: string }[]).map((p) => ({ ...p, quota: q.get(p.id) ?? null }));
}

/** null: back to the default quota. */
export async function setQuota(userId: string, usdPerMonth: number | null): Promise<void> {
  const { error } =
    usdPerMonth === null
      ? await supabase.from("ai_quotas").delete().eq("user_id", userId)
      : await supabase.from("ai_quotas").upsert({ user_id: userId, monthly_usd: usdPerMonth, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// ---------- developers ----------

export interface Budget {
  enabled: boolean;
  spent: number;
  /** null for admins (no quota of their own) */
  quota: number | null;
  cap_reached: boolean;
}

export async function myBudget(): Promise<Budget> {
  const { data, error } = await supabase.rpc("my_ai_budget");
  if (error) throw error;
  const b = data as Budget;
  return { ...b, spent: Number(b.spent), quota: b.quota === null ? null : Number(b.quota) };
}

export interface GitHubInfo {
  configured: boolean;
  /** GitHub's page for installing the Toki app, or choosing its repositories */
  installUrl: string | null;
  /** GitHub's login page for the Toki app: where "Connect GitHub" goes */
  authUrl?: string | null;
  /** Some connected account didn't answer just now: its repositories are missing from the list */
  unreachable?: boolean;
  installations?: { installation_id: number; account_login: string }[];
  repos?: { installation_id: number; account: string; repo: string; private: boolean }[];
}

export const githubInfo = () => api<GitHubInfo>("/api/github");
export const githubRepos = () => api<GitHubInfo>("/api/github?action=repos");
export const githubConnect = (code: string) =>
  api<{ installations: { installation_id: number; account_login: string }[] }>("/api/github", { method: "POST", body: JSON.stringify({ action: "connect", code }) });

/** Forgets the connection on Toki. (The app stays installed on GitHub until removed there.) */
export async function githubDisconnect(installationId: number): Promise<void> {
  const { error } = await supabase.from("github_installations").delete().eq("installation_id", installationId);
  if (error) throw error;
}

// Connecting GitHub. GitHub only sends people back to Toki from two places: its login page
// ("Authorize Toki"), always, and its install page, only the first time the app is installed on an
// account. So "Connect GitHub" goes to the login page: it works whether the app is installed yet
// or not. Only when it turns out nothing is installed, Toki sends the person on to the install
// page (src/pages/ConnectGitHub.tsx). Choosing more repositories happens on a GitHub page that
// never comes back, so that opens in a new tab and Toki looks again when its own tab is shown.

/** Remembered while the person is on GitHub: the answer must belong to this visit, and where to go after. */
const STATE_KEY = "toki.githubState";
const STATE_MS = 30 * 60_000;
function newState(back: string | null): string {
  const state = crypto.randomUUID();
  try {
    // localStorage, not sessionStorage: GitHub's answer sometimes arrives in another tab
    // (after logging in to GitHub, or in a phone's installed app).
    localStorage.setItem(STATE_KEY, JSON.stringify({ state, at: Date.now(), back }));
  } catch {
    /* without storage the check below fails and offers to try again */
  }
  return state;
}

/** "Connect GitHub": GitHub's login page. `back`: the page on Toki to return to afterwards. */
export function githubConnectLink(info: Pick<GitHubInfo, "authUrl" | "installUrl">, back: string | null = null): string {
  const state = encodeURIComponent(newState(back));
  return info.authUrl ? `${info.authUrl}&state=${state}` : `${info.installUrl}?state=${state}`;
}
/** Installing the Toki app on a GitHub account for the first time. */
export function githubInstallLink(installUrl: string, back: string | null = null): string {
  return `${installUrl}?state=${encodeURIComponent(newState(back))}`;
}
/** Whether GitHub's answer belongs to a visit started here (in the last half hour), and where to go after. */
export function githubStateCheck(state: string | null): { ok: boolean; back: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as { state?: string; at?: number; back?: string | null } | null;
    const fresh = !!saved && typeof saved.at === "number" && Date.now() - saved.at < STATE_MS;
    const back = fresh && typeof saved!.back === "string" ? saved!.back : null;
    if (!state || !fresh || saved!.state !== state) return { ok: false, back };
    localStorage.removeItem(STATE_KEY);
    return { ok: true, back };
  } catch {
    return { ok: false, back: null };
  }
}

/**
 * "Add repositories": GitHub's page for choosing what the Toki app may use, in a new tab. GitHub
 * doesn't come back from it, so `onBack` runs each time Toki's tab is shown again (for ten
 * minutes). Returns a function that stops that.
 */
export function githubManage(installUrl: string, onBack: () => void): () => void {
  window.open(installUrl, "_blank", "noopener");
  const started = Date.now();
  let last = 0;
  const back = () => {
    const now = Date.now();
    if (document.visibilityState !== "visible" || now - started < 1500 || now - last < 1500) return;
    last = now;
    onBack();
  };
  const stop = () => {
    clearTimeout(end);
    window.removeEventListener("focus", back);
    document.removeEventListener("visibilitychange", back);
  };
  const end = setTimeout(stop, 10 * 60_000);
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  return stop;
}

export type Feature = "saves" | "scores" | "multiplayer" | "fix";
export type JobStatus = "working" | "question" | "done" | "failed";

export interface Question {
  id: string;
  text: string;
  options?: string[];
}

export type JobMessage =
  | { from: "toki"; kind: "progress"; step: "read" | "more" | "agent"; count: number; at: string }
  | { from: "ai"; kind: "question"; text: string; questions: Question[]; at: string }
  | { from: "developer"; kind: "answer"; answers: { id: string; question: string; answer: string }[]; at: string }
  | { from: "ai"; kind: "done"; text: string; files: string[]; at: string }
  | { from: "ai"; kind: "impossible"; text: string; at: string };

export interface ConnectJob {
  /** "upload": a game hosted on Toki (its change goes live as a new version, no pull request) */
  source?: "github" | "upload";
  /** "agent": Claude Managed Agents works in its own copy of the repository */
  engine: "steps" | "agent";
  id: string;
  repo: string;
  features: Feature[];
  notes: string;
  status: JobStatus;
  messages: JobMessage[];
  pr_url: string | null;
  /** What became of the pull request: null until Toki asked GitHub (checkPrs) */
  pr_state?: "open" | "merged" | "closed" | null;
  error: string | null;
  /** What the AI service or GitHub answered */
  error_detail: string | null;
  game_id: string | null;
  /** the bug report a "fix" run is about */
  feedback_id: string | null;
  created_at: string;
  updated_at: string;
}

const JOB = "id, repo, features, notes, status, messages, pr_url, pr_state, error, error_detail, game_id, feedback_id, engine, source, created_at, updated_at";

export async function myJobs(): Promise<ConnectJob[]> {
  const { data, error } = await supabase.from("connect_jobs").select(JOB).order("created_at", { ascending: false }).limit(20);
  if (error) throw error;
  return data as ConnectJob[];
}

export async function getJob(id: string): Promise<ConnectJob | null> {
  const { data, error } = await supabase.from("connect_jobs").select(JOB).eq("id", id).maybeSingle();
  if (error) throw error;
  return data as ConnectJob | null;
}

/** What one run cost so far. */
export async function jobCost(id: string): Promise<number> {
  const { data, error } = await supabase.from("ai_usage").select("cost").eq("job_id", id);
  if (error) return 0;
  return (data as { cost: string }[]).reduce((sum, r) => sum + Number(r.cost), 0);
}

export interface StartJob {
  installation_id: number;
  repo: string;
  features: Feature[];
  notes: string;
  game_id: string | null;
  lang: "en" | "de";
  /** a bug report to fix (then features are ignored) */
  feedback_id?: string;
}

const connect = (body: Record<string, unknown>) => api<{ job: ConnectJob }>("/api/connect", { method: "POST", body: JSON.stringify(body) }).then((r) => r.job);
export const startJob = (j: StartJob) => connect({ action: "start", ...j });
/** The run's next step (at most one AI call). */
export const runJob = (id: string) => connect({ action: "run", id });
export const answerJob = (id: string, answers: { id: string; answer: string }[]) => connect({ action: "answer", id, answers });
export const cancelJob = (id: string) => connect({ action: "cancel", id });
/** Asks GitHub which of the account's Toki Connect pull requests were merged. `changed`: how many were merged or closed now. */
export const checkPrs = () => api<{ checked: number; changed?: number }>("/api/connect", { method: "POST", body: JSON.stringify({ action: "prs" }) });

const KNOWN_ERRORS = [
  "ai_disabled", "not_allowed", "cap_reached", "quota_reached", "ai_not_configured", "ai_provider_error", "ai_timeout", "ai_refused", "ai_empty_answer",
  "ai_bad_answer", "ai_bad_edits", "agent_budget", "github_not_found", "github_error", "github_not_configured", "too_many_steps", "impossible", "cancelled", "busy",
  "quick_off", "not_hosted",
] as const;
export type ConnectError = (typeof KNOWN_ERRORS)[number] | "error";

/** An error code the page has a text for. */
export const connectError = (code: string | null | undefined): ConnectError =>
  (KNOWN_ERRORS as readonly string[]).includes(code ?? "") ? (code as ConnectError) : "error";

export interface ModelInfo {
  id: string;
  name?: string;
  context?: number;
  /** US dollars per million tokens, when the endpoint says */
  inputPrice?: number;
  outputPrice?: number;
}

/** The models the provider offers, at the address in the form (empty: Anthropic itself). */
export const findModels = (provider: Provider, baseUrl: string) =>
  aiAction<{ models: ModelInfo[] }>({ action: "models", provider, base_url: baseUrl.trim() }).then((r) => r.models);

/** Models whose id or name contains every word of the search, in any order. */
export function searchModels(models: ModelInfo[], query: string): ModelInfo[] {
  const words = query.toLowerCase().split(/[\s/:_-]+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((m) => {
    const hay = `${m.id} ${m.name ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "128k", "1M" for a context size in tokens. */
export function tokensShort(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  return `${Math.round(n / 1000)}k`;
}
