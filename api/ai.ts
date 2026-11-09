// Admins: set up the AI key and the Toki GitHub App on Toki, see what is set up, and test the AI.
import { budgetedCompletion } from "../server/ai/budget.js";
import { errorCode } from "../server/connect/agent.js";
import { body, context, json } from "../server/http.js";
import { githubFromManifestCode, removeSecret, saveSecret } from "../server/secrets.js";

export async function GET(request: Request) {
  const ctx = await context(request, ["admin"]);
  if (ctx instanceof Response) return ctx;
  return json({
    serviceKey: true,
    aiKey: !!ctx.sources.aiKey,
    aiKeySource: ctx.sources.aiKey,
    github: !!ctx.sources.github,
    githubSource: ctx.sources.github,
    githubSlug: ctx.env.github.slug || null,
  });
}

export async function POST(request: Request) {
  const ctx = await context(request, ["admin"]);
  if (ctx instanceof Response) return ctx;
  const b = await body(request);
  switch (b.action) {
    case "test":
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
    case "set_ai_key": {
      const key = typeof b.key === "string" ? b.key.trim() : "";
      if (key.length < 8 || key.length > 500 || /\s/.test(key)) return json({ error: "bad_request" }, 400);
      await saveSecret(ctx.db, ctx.env, "ai_api_key", key, ctx.user.id);
      return json({ ok: true });
    }
    case "clear_ai_key":
      await removeSecret(ctx.db, "ai_api_key");
      return json({ ok: true });
    case "github_manifest": {
      // GitHub sends the admin back with a one-time code after they created the app there.
      const code = typeof b.code === "string" ? b.code : "";
      if (!/^[\w-]{1,100}$/.test(code)) return json({ error: "bad_request" }, 400);
      try {
        const { htmlUrl, ...app } = await githubFromManifestCode(code);
        await saveSecret(ctx.db, ctx.env, "github_app", JSON.stringify(app), ctx.user.id);
        return json({ ok: true, slug: app.slug, htmlUrl });
      } catch (e) {
        return json({ error: "github_error", message: e instanceof Error ? e.message.slice(0, 200) : "" }, 502);
      }
    }
    case "clear_github":
      await removeSecret(ctx.db, "github_app");
      return json({ ok: true });
    default:
      return json({ error: "bad_request" }, 400);
  }
}
