// The Managed Agents side of Toki Connect, through the official SDK: the agent and environment
// (made once, kept up to date with the settings), sessions, events and the agent's output file.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_URL, effortFor } from "../ai/anthropic.js";
import type { Thinking } from "../ai/provider.js";
import type { Db } from "../db.js";
import { AGENT_SYSTEM, AGENT_TOOLS, CHANGES_FILE, REPO_PATH, type AgentEvent } from "./managed.js";

export interface AgentSettings {
  base_url: string;
  model: string;
  thinking: Thinking;
  agent_budget: number;
  agent_id: string | null;
  agent_version: number | null;
  agent_config: string | null;
  environment_id: string | null;
}

// (The model and thinking come from ai_features: Toki Connect's "connect".)
export const AGENT_SETTINGS = "base_url,agent_budget,agent_id,agent_version,agent_config,environment_id";

export function agentClient(apiKey: string, baseUrl: string) {
  return new Anthropic({ apiKey, baseURL: baseUrl || ANTHROPIC_URL, timeout: 60_000, maxRetries: 1 });
}

function agentConfig(s: AgentSettings) {
  const effort = effortFor(s.thinking);
  return {
    name: "Toki Connect",
    description: "Adds Toki saves and high scores to web games, and fixes reported bugs.",
    model: effort ? { id: s.model, effort } : s.model,
    system: AGENT_SYSTEM,
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        // Nobody watches a run live, and the sandbox can't push or reach the web: allow its tools.
        default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
        configs: [
          { name: "web_fetch" as const, enabled: false },
          { name: "web_search" as const, enabled: false },
        ],
      },
      ...AGENT_TOOLS,
    ],
  };
}

/** The agent and environment, made once and updated when the model or thinking level changes. */
export async function ensureAgent(client: Anthropic, db: Db, s: AgentSettings): Promise<{ agentId: string; version: number; environmentId: string }> {
  const config = agentConfig(s);
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 64);
  let { agent_id: agentId, agent_version: version, environment_id: environmentId } = s;
  const patch: Record<string, unknown> = {};
  if (!environmentId) {
    const env = await client.beta.environments.create({
      name: "Toki Connect",
      // No network at all: bug reports come from players, so nothing they write can make the
      // agent install, download or publish anything.
      config: { type: "cloud", networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false } },
    });
    environmentId = env.id;
    patch.environment_id = env.id;
  }
  if (!agentId) {
    const a = await client.beta.agents.create(config);
    agentId = a.id;
    version = a.version;
    Object.assign(patch, { agent_id: a.id, agent_version: a.version, agent_config: hash });
  } else if (s.agent_config !== hash) {
    // Settings changed: a new version of the same agent (running sessions keep theirs).
    const a = await client.beta.agents.update(agentId, { ...config, version: version ?? undefined });
    version = a.version;
    Object.assign(patch, { agent_version: a.version, agent_config: hash });
  }
  if (Object.keys(patch).length) await db.update("ai_settings", "id=eq.1", patch);
  return { agentId, version: version ?? 1, environmentId };
}

export async function startSession(
  client: Anthropic,
  p: { agentId: string; version: number; environmentId: string; repo: string; token: string; branch: string; budgetUsd: number; text: string; jobId: string },
): Promise<string> {
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: p.agentId, version: p.version },
    environment_id: p.environmentId,
    title: `Toki Connect: ${p.repo}`,
    metadata: { toki_job: p.jobId },
    budget: { type: "limit", max_list_cost: { amount: String(Math.max(1, Math.round(p.budgetUsd * 100))), currency: "USD" } },
    resources: [
      {
        type: "github_repository",
        url: `https://github.com/${p.repo}`,
        mount_path: REPO_PATH,
        // Read-only and for this repository only; it never enters the sandbox.
        authorization_token: p.token,
        checkout: { type: "branch", name: p.branch },
      },
    ],
    initial_events: [{ type: "user.message", content: [{ type: "text", text: p.text }] }],
  });
  return session.id;
}

export async function sessionStatus(client: Anthropic, id: string) {
  const s = await client.beta.sessions.retrieve(id);
  const cents = Number((s as { usage?: { list_cost?: { amount?: string } } }).usage?.list_cost?.amount ?? 0);
  return { status: s.status as "idle" | "running" | "rescheduling" | "terminated", cost: Number.isFinite(cents) ? cents / 100 : 0 };
}

/** The events Toki acts on, oldest first. */
export async function sessionEvents(client: Anthropic, id: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const raw of client.beta.sessions.events.list(id, { limit: 1000 })) {
    const e = raw as unknown as { type: string; id: string; name?: string; input?: unknown; stop_reason?: { type?: string }; error?: { message?: string }; message?: string };
    if (e.type === "agent.custom_tool_use") {
      out.push({ type: "custom_tool_use", id: e.id, name: e.name ?? "", input: e.input && typeof e.input === "object" ? (e.input as Record<string, unknown>) : {} });
    } else if (e.type === "session.status_idle") {
      out.push({ type: "idle", stop: e.stop_reason?.type ?? "" });
    } else if (e.type === "session.error") {
      out.push({ type: "error", message: e.error?.message ?? e.message ?? "error" });
    }
    if (out.length > 5000) break;
  }
  return out;
}

export const replyTool = (client: Anthropic, id: string, toolUseId: string, text: string) =>
  client.beta.sessions.events.send(id, { events: [{ type: "user.custom_tool_result", custom_tool_use_id: toolUseId, content: [{ type: "text", text }] }] }).then(() => {});

export const sendMessage = (client: Anthropic, id: string, text: string) =>
  client.beta.sessions.events.send(id, { events: [{ type: "user.message", content: [{ type: "text", text }] }] }).then(() => {});

export const interrupt = (client: Anthropic, id: string) =>
  client.beta.sessions.events.send(id, { events: [{ type: "user.interrupt" }] }).then(() => {});

/** The changes file the agent wrote to /mnt/session/outputs (it may take a few seconds to show up). */
export async function changesFile(client: Anthropic, id: string): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const list = await client.beta.files.list({ scope_id: id, betas: ["managed-agents-2026-04-01"] });
    const f = list.data.find((x) => (x as { filename?: string }).filename === CHANGES_FILE);
    if (f) {
      const res = await client.beta.files.download(f.id);
      const text = await res.text();
      return text.length > 2_000_000 ? null : text;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
