// Toki Connect for developers: start a run, take its next step, answer the AI's questions, cancel.
// Every action checks that the run (and the GitHub installation) belongs to the logged-in account.
import { budgetedCompletion } from "../server/ai/budget.js";
import { freeCompletion, freeSettings } from "../server/ai/free.js";
import { addable, errorCode, errorDetail, step, uploadFeatures, type Bug, type Feature, type Job, type Message, type StepResult } from "../server/connect/agent.js";
import { agentStep } from "../server/connect/managed.js";
import {
  AGENT_SETTINGS, agentClient, changesFile, ensureAgent, interrupt, replyTool, sendMessage, sessionEvents, sessionStatus, startSession, type AgentSettings,
} from "../server/connect/managedClient.js";
import Anthropic from "@anthropic-ai/sdk";
import { DbError } from "../server/db.js";
import { githubConfigured } from "../server/env.js";
import { github } from "../server/github.js";
import { body, context, isUuid, json, type Ctx } from "../server/http.js";
import { buildRepo } from "../server/connect/buildRepo.js";
import { hostingDeps, r2Config } from "../server/hosting.js";
import { SITE_URL } from "../src/lib/site.js";

const PUBLIC = "id,repo,features,notes,status,messages,pr_url,pr_state,error,error_detail,game_id,feedback_id,engine,source,ai,created_at,updated_at";
// A step holds the run this long at most; a crashed step frees it again after that.
const LEASE_MS = 290_000;

interface Row extends Omit<Job, "game" | "bug"> {
  engine: "steps" | "agent";
  ai: "strong" | "free";
  user_id: string;
  installation_id: number | null;
  game_id: string | null;
  pr_url: string | null;
  error: string | null;
}

export async function POST(request: Request) {
  const ctx = await context(request, ["admin", "creator"]);
  if (ctx instanceof Response) return ctx;
  const b = await body(request);
  try {
    switch (b.action) {
      case "start":
        return await start(ctx, b);
      case "run":
        return await run(ctx, b, new URL(request.url).origin);
      case "answer":
        return await answer(ctx, b);
      case "cancel":
        return await cancel(ctx, b);
      case "prs":
        return await prs(ctx);
      default:
        return json({ error: "bad_request" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof DbError ? e.message : "error" }, 500);
  }
}

async function view(ctx: Ctx, id: string) {
  const [job] = await ctx.db.select(`connect_jobs`, `id=eq.${id}&user_id=eq.${ctx.user.id}&select=${PUBLIC}`);
  return job ? json({ job }) : json({ error: "not_found" }, 404);
}

/** Which AI writes the code: one-click runs use the admin's choice for them, others the strong AI. */
async function whichAi(ctx: Ctx, quick: boolean): Promise<"strong" | "free" | Response> {
  if (!quick) return "strong";
  const [s] = await ctx.db.select<{ quick_code_ai: "free" | "strong" | "off" }>("ai_settings", "id=eq.1&select=quick_code_ai");
  const choice = s?.quick_code_ai ?? "free";
  if (choice === "off") return json({ error: "quick_off" }, 503);
  if (choice === "free" && (!(await freeSettings(ctx.db)) || !(ctx.env.freeAiKey || ctx.env.aiKey))) return json({ error: "ai_not_configured" }, 503);
  return choice;
}

/** A run on a game uploaded to Toki: Toki Connect reads its live files and puts its change live. */
async function startUpload(ctx: Ctx, b: Record<string, unknown>) {
  if (!isUuid(b.game_id)) return json({ error: "bad_request" }, 400);
  const [game] = await ctx.db.select<{ created_by: string | null; hosted_site: string | null }>("games", `id=eq.${b.game_id}&select=created_by,hosted_site`);
  if (!game || (game.created_by !== ctx.user.id && ctx.user.role !== "admin")) return json({ error: "not_allowed" }, 403);
  const [live] = await ctx.db.select("game_builds", `game_id=eq.${b.game_id}&status=eq.live&select=id`);
  if (!game.hosted_site || !live) return json({ error: "not_hosted" }, 409);
  const ai = await whichAi(ctx, b.quick === true);
  if (ai instanceof Response) return ai;
  if (ai === "strong") {
    const [settings] = await ctx.db.select<{ enabled: boolean }>("ai_settings", "id=eq.1&select=enabled");
    if (!settings?.enabled || (!ctx.env.aiKey && !ctx.env.anthropicKey)) return json({ error: "ai_disabled" }, 503);
  }
  try {
    const [job] = await ctx.db.insert<{ id: string }>("connect_jobs", {
      user_id: ctx.user.id,
      installation_id: null,
      source: "upload",
      repo: `toki/${game.hosted_site}`,
      features: uploadFeatures(b.features),
      notes: typeof b.notes === "string" ? b.notes.trim().slice(0, 1000) : "",
      game_id: b.game_id,
      engine: "steps",
      ai,
      state: { lang: b.lang === "de" ? "de" : "en" },
    });
    return view(ctx, job.id);
  } catch (e) {
    if (e instanceof DbError && e.code === "23505") return json({ error: "busy" }, 409);
    throw e;
  }
}

async function start(ctx: Ctx, b: Record<string, unknown>) {
  if (b.source === "upload") return startUpload(ctx, b);
  const quick = b.quick === true;
  const ai = await whichAi(ctx, quick);
  if (ai instanceof Response) return ai;
  // A game that follows a branch: the change goes to that branch (the pull request's base).
  const branch = typeof b.branch === "string" && /^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/.test(b.branch) ? b.branch : undefined;
  const installation = Number(b.installation_id);
  const repo = typeof b.repo === "string" ? b.repo : "";
  // A bug fix: the feedback post says which game, and only the game's developer (or an admin) may.
  const feedbackId = isUuid(b.feedback_id) ? b.feedback_id : null;
  const features: Feature[] = feedbackId
    ? ["fix"]
    : addable(b.features);
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 1000) : "";
  let gameId = isUuid(b.game_id) ? b.game_id : null;
  if (feedbackId) {
    const [post] = await ctx.db.select<{ game_id: string | null; kind: string }>("feedback_posts", `id=eq.${feedbackId}&select=game_id,kind`);
    if (!post || post.kind !== "bug") return json({ error: "not_found" }, 404);
    if (!post.game_id && ctx.user.role !== "admin") return json({ error: "not_allowed" }, 403);
    gameId = post.game_id;
  }
  if (!Number.isSafeInteger(installation) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !features.length) return json({ error: "bad_request" }, 400);
  if (ai === "strong" && !ctx.env.aiKey && !ctx.env.anthropicKey) return json({ error: "ai_not_configured" }, 503);
  if (!githubConfigured(ctx.env.github)) return json({ error: "github_not_configured" }, 503);
  const [settings] = await ctx.db.select<{ enabled: boolean; provider: string; agent_enabled: boolean }>("ai_settings", "id=eq.1&select=enabled,provider,agent_enabled");
  if (ai === "strong" && !settings?.enabled) return json({ error: "ai_disabled" }, 503);
  // Claude Managed Agents when the admin turned it on (Anthropic only); otherwise step by step.
  const engine = ai === "strong" && settings.agent_enabled && settings.provider === "anthropic" && ctx.env.anthropicKey ? "agent" : "steps";

  // The installation must be one GitHub confirmed for this account, and the repository one it can use.
  const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${installation}&select=installation_id`);
  if (!owned) return json({ error: "not_allowed" }, 403);
  const repos = await github(ctx.env.github).repos(installation);
  if (!repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return json({ error: "not_allowed" }, 403);
  if (gameId) {
    const [game] = await ctx.db.select<{ created_by: string }>("games", `id=eq.${gameId}&select=created_by`);
    if (!game || (game.created_by !== ctx.user.id && ctx.user.role !== "admin")) return json({ error: "not_allowed" }, 403);
  }
  try {
    const [job] = await ctx.db.insert<{ id: string }>("connect_jobs", {
      user_id: ctx.user.id,
      installation_id: installation,
      repo,
      features,
      notes,
      game_id: gameId,
      feedback_id: feedbackId,
      engine,
      ai,
      state: { lang: b.lang === "de" ? "de" : "en", ...(branch ? { branch } : {}) },
    });
    return view(ctx, job.id);
  } catch (e) {
    if (e instanceof DbError && e.code === "23505") return json({ error: "busy" }, 409);
    throw e;
  }
}

async function run(ctx: Ctx, b: Record<string, unknown>, origin: string) {
  if (!isUuid(b.id)) return json({ error: "bad_request" }, 400);
  const now = new Date();
  const free = `or=(lease_until.is.null,lease_until.lt.${encodeURIComponent(`"${now.toISOString()}"`)})`;
  // Take the run for this step; if another step is working on it, just report where it stands.
  const [job] = await ctx.db.update<Row>(
    "connect_jobs",
    `id=eq.${b.id}&user_id=eq.${ctx.user.id}&status=eq.working&${free}&select=*`,
    { lease_until: new Date(now.getTime() + LEASE_MS).toISOString() },
  );
  if (!job) return view(ctx, b.id);

  let game: Job["game"] = null;
  if (job.game_id) {
    [game] = await ctx.db.select<NonNullable<Job["game"]>>("games", `id=eq.${job.game_id}&select=title,score_order,score_format,join_param`);
    if (game && job.features.includes("achievements")) {
      game.achievements = await ctx.db.select<{ id: string; name: string; description: string }>(
        "game_achievements", `game_id=eq.${job.game_id}&select=id,name,description&order=position,id`,
      );
    }
    // The game's other high-score lists, so the AI sends scores to the right one.
    if (game && (job.features.includes("boards") || job.features.includes("scores"))) {
      game.boards = await ctx.db.select<{ id: string; name: string; score_order: "high" | "low"; score_format: "points" | "time" }>(
        "game_boards", `game_id=eq.${job.game_id}&select=id,name,score_order,score_format&order=position,id`,
      ).catch(() => []);
    }
  }
  let bug: Bug | null = null;
  if (job.feedback_id) {
    const [post] = await ctx.db.select<{ title: string; body: string; device: string | null }>("feedback_posts", `id=eq.${job.feedback_id}&select=title,body,device`);
    const replies = await ctx.db.select<{ body: string }>("feedback_replies", `post_id=eq.${job.feedback_id}&select=body&order=created_at&limit=20`);
    if (post) bug = { title: post.title, body: post.body, device: post.device, replies: replies.map((r) => r.body.slice(0, 1000)) };
  }
  if (job.engine === "agent") {
    const result = await runAgent(ctx, job, { ...job, game, bug }, origin);
    if (!(await saveStep(ctx, job, result)) && result.state.session) {
      // Cancelled while this step worked (e.g. while the session was being started): stop the
      // agent and count what it cost, since the cancel couldn't see the session yet.
      await stopAgent(ctx, result.state.session, result.state.reservation);
    }
    return view(ctx, job.id);
  }
  // The free AI does the easy steps, when it's set up and the admin allows it.
  const [opts] = await ctx.db.select<{ connect_free_steps: boolean; max_output_tokens: number | null }>("ai_settings", "id=eq.1&select=connect_free_steps,max_output_tokens");
  const freeAi = opts?.connect_free_steps && (ctx.env.freeAiKey || ctx.env.aiKey) ? await freeSettings(ctx.db) : null;
  const gh = github(ctx.env.github);
  const freeOnly = job.ai === "free" ? await freeSettings(ctx.db) : null;
  const result = await step({ ...job, game, bug }, {
    origin: SITE_URL,
    maxOutputTokens: opts?.max_output_tokens ?? undefined,
    async repo() {
      if (job.source === "upload") {
        const { config } = await r2Config(ctx.db, ctx.env.serviceKey);
        if (!config || !job.game_id) throw new DbError("not_allowed", 403);
        return buildRepo(hostingDeps(ctx.db, config), { id: ctx.user.id, role: ctx.user.role }, job.game_id);
      }
      // Still connected? (The developer may have disconnected GitHub since.)
      const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${job.installation_id}&select=installation_id`);
      if (!owned || job.installation_id === null) throw new DbError("not_allowed", 403);
      return gh.repo(job.installation_id, job.repo);
    },
    async ai(messages, maxTokens, opts) {
      // One-click runs where the admin chose the free AI: it writes the code too (no cost).
      if (job.ai === "free") {
        const c = await freeCompletion({ db: ctx.db, keys: { free: ctx.env.freeAiKey, openai: ctx.env.aiKey }, userId: ctx.user.id, feature: "connect", messages, settings: freeOnly, timeoutMs: 240_000 });
        return c.text;
      }
      const c = await budgetedCompletion({ db: ctx.db, keys: { openai_compatible: ctx.env.aiKey, anthropic: ctx.env.anthropicKey }, userId: ctx.user.id, feature: "connect", jobId: job.id, messages, maxTokens, thinking: opts?.thinking });
      return c.text;
    },
    ...(freeAi && job.ai !== "free"
      ? {
          async free(messages: Parameters<typeof freeCompletion>[0]["messages"]) {
            const c = await freeCompletion({ db: ctx.db, keys: { free: ctx.env.freeAiKey, openai: ctx.env.aiKey }, userId: ctx.user.id, feature: "connect", messages, settings: freeAi, timeoutMs: 120_000 });
            return c.text;
          },
        }
      : {}),
    async script() {
      const res = await fetch(new URL("/toki-save.js", origin));
      if (!res.ok) throw new Error("toki-save.js not found");
      return res.text();
    },
  });
  await saveStep(ctx, job, result);
  return view(ctx, job.id);
}

/** false when the run was cancelled meanwhile (then nothing is saved). */
async function saveStep(ctx: Ctx, job: Row, result: StepResult): Promise<boolean> {
  const rows = await ctx.db.update("connect_jobs", `id=eq.${job.id}&status=eq.working`, {
    status: result.status,
    messages: result.messages,
    state: result.state,
    pr_url: result.pr_url ?? job.pr_url,
    error: result.error ?? null,
    error_detail: result.error_detail ?? null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  });
  // Friend invites were added: the game's page offers "Invite friends" from now on.
  if (rows.length && result.status === "done" && job.features.includes("multiplayer") && job.game_id) {
    await ctx.db.update("games", `id=eq.${job.game_id}`, { multiplayer: true }).catch(() => {});
  }
  // Achievements the AI proposed for a game that had none: the game has them on Toki now (only
  // ones it doesn't have yet are added, so nothing the developer set is changed).
  if (rows.length && result.status === "done" && result.achievements?.length && job.game_id) {
    await ctx.db.rpc("set_achievements", { p_game: job.game_id, p_list: result.achievements, p_mode: "add" }).catch(() => {});
  }
  // High-score lists the AI proposed for a game that had none: likewise, only new ones are added.
  if (rows.length && result.status === "done" && result.boards?.length && job.game_id) {
    await ctx.db.rpc("set_boards", { p_game: job.game_id, p_list: result.boards, p_mode: "add" }).catch(() => {});
  }
  return rows.length > 0;
}

/** Stops an agent's session and settles its reservation at what it cost (the whole cap if unknown). */
async function stopAgent(ctx: Ctx, session: string, reservation: number | undefined) {
  const [s] = await ctx.db.select<{ base_url: string; agent_budget: string }>("ai_settings", "id=eq.1&select=base_url,agent_budget");
  const client = agentClient(ctx.env.anthropicKey, s?.base_url ?? "");
  await interrupt(client, session).catch(() => {});
  const cost = await sessionStatus(client, session).then((x) => x.cost, () => 0);
  if (reservation) {
    await ctx.db.rpc("ai_settle_amount", { p_id: reservation, p_cost: cost > 0 ? cost : Number(s?.agent_budget ?? 0), p_ok: false }).catch(() => {});
  }
}

/** Errors that pass (Anthropic briefly unreachable or busy): try again on the next step. */
const passing = (e: unknown) =>
  e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && (e.status === 429 || (e.status ?? 0) >= 500));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One step of a Managed Agents run. Before the session starts, the run's whole cap is reserved in
 * the AI budget (so quotas and Toki's monthly cap hold); when it ends, its real cost replaces that.
 */
async function runAgent(ctx: Ctx, row: Row, job: Job, origin: string): Promise<StepResult> {
  const [s] = await ctx.db.select<AgentSettings & { output_price: string }>("ai_settings", `id=eq.1&select=${AGENT_SETTINGS},output_price`);
  const client = agentClient(ctx.env.anthropicKey, s.base_url);
  const budget = Number(s.agent_budget);
  const state = { ...(job.state ?? {}) };
  // A run that started always cost something; if the cost isn't known yet, count the whole cap.
  const settle = async (cost: number, ok: boolean) => {
    const amount = cost > 0 || !state.session ? cost : budget;
    if (state.reservation) await ctx.db.rpc("ai_settle_amount", { p_id: state.reservation, p_cost: amount, p_ok: ok }).catch(() => {});
  };
  try {
    if (!state.session) {
      // The cap in tokens of the model's output price, so ai_reserve can check it against the limits.
      const r = await ctx.db.rpc<{ id: number }>("ai_reserve", {
        p_user: ctx.user.id,
        p_feature: "connect",
        p_job: row.id,
        p_input_tokens: 0,
        // (capped to the database's integer range; such a cheap model reserves a bit less)
        p_max_output_tokens: Math.min(2_000_000_000, Math.ceil((budget * 1_000_000) / Math.max(Number(s.output_price), 0.0001))),
      });
      state.reservation = r.id;
    }
    const gh = github(ctx.env.github);
    const result = await agentStep({ ...job, state }, {
      origin: SITE_URL,
      script: async () => {
        const res = await fetch(new URL("/toki-save.js", origin));
        if (!res.ok) throw new Error("toki-save.js not found");
        return res.text();
      },
      async start(text) {
        const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${row.installation_id!}&select=installation_id`);
        if (!owned) throw new DbError("not_allowed", 403);
        const a = await ensureAgent(client, ctx.db, s);
        const branch = row.state?.branch ?? (await (await gh.repo(row.installation_id!, row.repo)).defaultBranch());
        const token = await gh.readOnlyToken(row.installation_id!, row.repo);
        return startSession(client, { ...a, repo: row.repo, token, branch, budgetUsd: budget, text, jobId: row.id });
      },
      status: (id) => sessionStatus(client, id),
      events: (id) => sessionEvents(client, id),
      reply: (id, toolUseId, text) => replyTool(client, id, toolUseId, text),
      message: (id, text) => sendMessage(client, id, text),
      interrupt: (id) => interrupt(client, id),
      changes: (id) => changesFile(client, id),
      async openPullRequest(p) {
        const repo = await gh.repo(row.installation_id!, row.repo);
        return repo.openPullRequest({ ...p, base: row.state?.branch ?? (await repo.defaultBranch()), branch: `toki-connect/${row.id.slice(0, 8)}`, message: p.title });
      },
      async wait() {
        // Up to about 20 seconds while the agent works, so the page doesn't ask every few seconds.
        for (let i = 0; i < 5; i++) {
          await sleep(4000);
          const st = await sessionStatus(client, state.session!);
          if (st.status !== "running" && st.status !== "rescheduling") return;
        }
      },
    });
    if (result.status === "done" || result.status === "failed") await settle(result.cost ?? 0, result.status === "done");
    return { ...result, state: { ...result.state, hiccups: 0 } };
  } catch (e) {
    // Anthropic briefly unreachable during a run: keep it, and look again next step (a few times).
    if (state.session && passing(e) && (state.hiccups ?? 0) < 5) {
      return { status: "working", messages: job.messages, state: { ...state, hiccups: (state.hiccups ?? 0) + 1 }, error: null };
    }
    // What it cost so far, if a session was started.
    const cost = state.session ? await sessionStatus(client, state.session).then((x) => x.cost, () => budget) : 0;
    if (state.session) await interrupt(client, state.session).catch(() => {});
    await settle(cost, false);
    const code = e instanceof Anthropic.APIError ? "ai_provider_error" : errorCode(e);
    const detail = e instanceof Anthropic.APIError ? `${e.status ?? ""}: ${e.message}`.slice(0, 500) : errorDetail(e);
    return { status: "failed", messages: job.messages, state, error: code, error_detail: detail };
  }
}

async function answer(ctx: Ctx, b: Record<string, unknown>) {
  if (!isUuid(b.id) || !Array.isArray(b.answers)) return json({ error: "bad_request" }, 400);
  const [job] = await ctx.db.select<Row>("connect_jobs", `id=eq.${b.id}&user_id=eq.${ctx.user.id}&status=eq.question&select=id,messages`);
  if (!job) return json({ error: "not_found" }, 404);
  const asked = [...job.messages].reverse().find((m): m is Extract<Message, { kind: "question" }> => m.kind === "question");
  if (!asked) return json({ error: "not_found" }, 404);
  const given = new Map(
    (b.answers as { id?: unknown; answer?: unknown }[]).map((a) => [String(a?.id ?? ""), typeof a?.answer === "string" ? a.answer.trim().slice(0, 500) : ""]),
  );
  const answers = asked.questions.map((q) => ({ id: q.id, question: q.text, answer: given.get(q.id) || "(no answer: decide yourself)" }));
  const messages: Message[] = [...job.messages, { from: "developer", kind: "answer", answers, at: new Date().toISOString() }];
  await ctx.db.update("connect_jobs", `id=eq.${job.id}&status=eq.question`, { status: "working", messages, updated_at: new Date().toISOString() });
  return view(ctx, job.id);
}

async function cancel(ctx: Ctx, b: Record<string, unknown>) {
  if (!isUuid(b.id)) return json({ error: "bad_request" }, 400);
  const [job] = await ctx.db.update<Row>("connect_jobs", `id=eq.${b.id}&user_id=eq.${ctx.user.id}&status=in.(working,question)&select=engine,state`, {
    status: "failed",
    error: "cancelled",
    lease_until: null,
    updated_at: new Date().toISOString(),
  });
  // An agent run: stop the agent, and count what it cost so far instead of the whole cap.
  if (job?.engine === "agent" && job.state?.session) await stopAgent(ctx, job.state.session, job.state.reservation);
  return view(ctx, b.id);
}

/**
 * Asks GitHub about the account's open Toki Connect pull requests (the newest few) and notes
 * which were merged or closed, so "Updates for your games" knows a game is done.
 */
async function prs(ctx: Ctx) {
  if (!githubConfigured(ctx.env.github)) return json({ checked: 0 });
  const rows = await ctx.db.select<{ id: string; repo: string; pr_url: string; installation_id: number | null }>(
    "connect_jobs",
    `user_id=eq.${ctx.user.id}&status=eq.done&pr_url=not.is.null&or=(pr_state.is.null,pr_state.eq.open)&select=id,repo,pr_url,installation_id&order=created_at.desc&limit=10`,
  );
  const gh = github(ctx.env.github);
  let changed = 0;
  await Promise.all(
    rows.map(async (r) => {
      const n = Number(/\/pull\/(\d+)$/.exec(r.pr_url)?.[1]);
      if (!r.installation_id || !n) return;
      try {
        const state = await (await gh.repo(r.installation_id, r.repo)).pullState(n);
        await ctx.db.update("connect_jobs", `id=eq.${r.id}`, { pr_state: state });
        if (state !== "open") changed++;
      } catch {
        /* GitHub didn't answer, or the app lost access: ask again next time */
      }
    }),
  );
  return json({ checked: rows.length, changed });
}
