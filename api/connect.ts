// Toki Connect for developers: start a run, take its next step, answer the AI's questions, cancel.
// Every action checks that the run (and the GitHub installation) belongs to the logged-in account.
import { budgetedCompletion } from "../server/ai/budget.js";
import { freeCompletion, freeSettings } from "../server/ai/free.js";
import { step, type Bug, type Feature, type Job, type Message } from "../server/connect/agent.js";
import { DbError } from "../server/db.js";
import { githubConfigured } from "../server/env.js";
import { github } from "../server/github.js";
import { body, context, isUuid, json, type Ctx } from "../server/http.js";

const PUBLIC = "id,repo,features,notes,status,messages,pr_url,error,error_detail,game_id,feedback_id,created_at,updated_at";
// A step holds the run this long at most; a crashed step frees it again after that.
const LEASE_MS = 290_000;

interface Row extends Omit<Job, "game" | "bug"> {
  user_id: string;
  installation_id: number;
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

async function start(ctx: Ctx, b: Record<string, unknown>) {
  const installation = Number(b.installation_id);
  const repo = typeof b.repo === "string" ? b.repo : "";
  // A bug fix: the feedback post says which game, and only the game's developer (or an admin) may.
  const feedbackId = isUuid(b.feedback_id) ? b.feedback_id : null;
  const features: Feature[] = feedbackId
    ? ["fix"]
    : Array.isArray(b.features) ? [...new Set(b.features.filter((f): f is Feature => f === "saves" || f === "scores"))] : [];
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 1000) : "";
  let gameId = isUuid(b.game_id) ? b.game_id : null;
  if (feedbackId) {
    const [post] = await ctx.db.select<{ game_id: string | null; kind: string }>("feedback_posts", `id=eq.${feedbackId}&select=game_id,kind`);
    if (!post || post.kind !== "bug") return json({ error: "not_found" }, 404);
    if (!post.game_id && ctx.user.role !== "admin") return json({ error: "not_allowed" }, 403);
    gameId = post.game_id;
  }
  if (!Number.isSafeInteger(installation) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !features.length) return json({ error: "bad_request" }, 400);
  if (!ctx.env.aiKey && !ctx.env.anthropicKey) return json({ error: "ai_not_configured" }, 503);
  if (!githubConfigured(ctx.env.github)) return json({ error: "github_not_configured" }, 503);
  const [settings] = await ctx.db.select<{ enabled: boolean }>("ai_settings", "id=eq.1&select=enabled");
  if (!settings?.enabled) return json({ error: "ai_disabled" }, 503);

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
      state: { lang: b.lang === "de" ? "de" : "en" },
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
    [game] = await ctx.db.select<NonNullable<Job["game"]>>("games", `id=eq.${job.game_id}&select=title,score_order,score_format`);
  }
  let bug: Bug | null = null;
  if (job.feedback_id) {
    const [post] = await ctx.db.select<{ title: string; body: string; device: string | null }>("feedback_posts", `id=eq.${job.feedback_id}&select=title,body,device`);
    const replies = await ctx.db.select<{ body: string }>("feedback_replies", `post_id=eq.${job.feedback_id}&select=body&order=created_at&limit=20`);
    if (post) bug = { title: post.title, body: post.body, device: post.device, replies: replies.map((r) => r.body.slice(0, 1000)) };
  }
  // The free AI does the easy steps, when it's set up and the admin allows it.
  const [opts] = await ctx.db.select<{ connect_free_steps: boolean }>("ai_settings", "id=eq.1&select=connect_free_steps");
  const freeAi = opts?.connect_free_steps && ctx.env.aiKey ? await freeSettings(ctx.db) : null;
  const gh = github(ctx.env.github);
  const result = await step({ ...job, game, bug }, {
    origin,
    async repo() {
      // Still connected? (The developer may have disconnected GitHub since.)
      const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${job.installation_id}&select=installation_id`);
      if (!owned) throw new DbError("not_allowed", 403);
      return gh.repo(job.installation_id, job.repo);
    },
    async ai(messages, maxTokens) {
      const c = await budgetedCompletion({ db: ctx.db, keys: { openai_compatible: ctx.env.aiKey, anthropic: ctx.env.anthropicKey }, userId: ctx.user.id, feature: "connect", jobId: job.id, messages, maxTokens });
      return c.text;
    },
    ...(freeAi
      ? {
          async free(messages: Parameters<typeof freeCompletion>[0]["messages"]) {
            const c = await freeCompletion({ db: ctx.db, apiKey: ctx.env.aiKey, userId: ctx.user.id, feature: "connect", messages, settings: freeAi, timeoutMs: 120_000 });
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
  // Only if it wasn't cancelled meanwhile.
  await ctx.db.update("connect_jobs", `id=eq.${job.id}&status=eq.working`, {
    status: result.status,
    messages: result.messages,
    state: result.state,
    pr_url: result.pr_url ?? job.pr_url,
    error: result.error ?? null,
    error_detail: result.error_detail ?? null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  });
  return view(ctx, job.id);
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
  await ctx.db.update("connect_jobs", `id=eq.${b.id}&user_id=eq.${ctx.user.id}&status=in.(working,question)`, {
    status: "failed",
    error: "cancelled",
    lease_until: null,
    updated_at: new Date().toISOString(),
  });
  return view(ctx, b.id);
}
