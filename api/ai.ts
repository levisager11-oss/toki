// Admins: whether the AI and GitHub keys are set up, and a test call to the AI endpoint.
import { budgetedCompletion } from "../server/ai/budget.js";
import { githubConfigured } from "../server/env.js";
import { body, context, json } from "../server/http.js";
import { errorCode } from "../server/connect/agent.js";

export async function GET(request: Request) {
  const ctx = await context(request, ["admin"]);
  if (ctx instanceof Response) return ctx;
  return json({ aiKey: !!ctx.env.aiKey, serviceKey: true, github: githubConfigured(ctx.env.github), githubSlug: ctx.env.github.slug || null });
}

export async function POST(request: Request) {
  const ctx = await context(request, ["admin"]);
  if (ctx instanceof Response) return ctx;
  if ((await body(request)).action !== "test") return json({ error: "bad_request" }, 400);
  try {
    const c = await budgetedCompletion({
      db: ctx.db,
      apiKey: ctx.env.aiKey,
      userId: ctx.user.id,
      feature: "test",
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 16,
    });
    return json({ ok: true, text: c.text.slice(0, 200), inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimated: c.estimated, cost: c.cost });
  } catch (e) {
    return json({ ok: false, error: errorCode(e), message: e instanceof Error ? e.message.slice(0, 300) : "" });
  }
}
