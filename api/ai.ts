// Admins: set up the AI key and the Toki GitHub App on Toki, see what is set up, and test the AI.
import { AI_FEATURES, budgetedCompletion } from "../server/ai/budget.js";
import { anthropicCheckKey } from "../server/ai/anthropic.js";
import { AiError, listModels } from "../server/ai/provider.js";
import { errorCode } from "../server/connect/agent.js";
import { body, context, json, type Ctx } from "../server/http.js";
import { githubFromManifestCode, removeSecret, saveSecret } from "../server/secrets.js";

export async function GET(request: Request) {
  const ctx = await context(request, ["admin"]);
  if (ctx instanceof Response) return ctx;
  return json({
    serviceKey: true,
    anthropicKey: !!ctx.sources.anthropicKey,
    anthropicKeySource: ctx.sources.anthropicKey,
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
          keys: { openai_compatible: "", anthropic: ctx.env.anthropicKey },
          userId: ctx.user.id,
          feature: "test",
          // The feature whose model is tried.
          testFeature: AI_FEATURES.find((f) => f === b.feature) ?? "connect",
          messages: [{ role: "user", content: "Reply with the single word OK." }],
          // Room for models that think before answering; the real cost is what gets counted.
          maxTokens: 1024,
        });
        return json({ ok: true, text: c.text.slice(0, 200), inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimated: c.estimated, cost: c.cost });
      } catch (e) {
        return json({ ok: false, error: errorCode(e), message: e instanceof Error ? e.message.slice(0, 300) : "" });
      }
    case "models": {
      // Claude's models, through the address chosen in the form (before saving; empty: Anthropic).
      const baseUrl = typeof b.base_url === "string" ? b.base_url.trim() : "";
      if (baseUrl && (!/^https:\/\/\S+$/.test(baseUrl) || baseUrl.length > 300)) return json({ error: "bad_url" }, 400);
      try {
        const models = await listModels({ provider: "anthropic", baseUrl, apiKey: ctx.env.anthropicKey });
        return json({ models });
      } catch (e) {
        return json({ error: errorCode(e), message: e instanceof Error ? e.message.slice(0, 300) : "" }, 502);
      }
    }
    case "set_ai_key": {
      const key = typeof b.key === "string" ? b.key.trim() : "";
      if (key.length < 8 || key.length > 500 || /\s/.test(key)) return json({ error: "bad_request" }, 400);
      // Asks Anthropic first (the Models API costs nothing), so a mistyped key never gets saved.
      // When Anthropic can't be reached, the admin may save it anyway ("force").
      const checked = await checkKey(ctx, key);
      if (!checked.ok && (checked.error === "ai_bad_key" || b.force !== true)) return json(checked, checked.error === "ai_bad_key" ? 400 : 502);
      await saveSecret(ctx.db, ctx.env, "anthropic_api_key", key, ctx.user.id);
      return json({ ok: true, checked: checked.ok, models: checked.ok ? checked.models : 0 });
    }
    case "check_key":
      // The key in use (from Toki or Vercel): does Anthropic accept it?
      if (!ctx.env.anthropicKey) return json({ ok: false, error: "ai_not_configured" });
      return json(await checkKey(ctx, ctx.env.anthropicKey));
    case "clear_ai_key":
      await removeSecret(ctx.db, "anthropic_api_key");
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

async function checkKey(ctx: Ctx, key: string) {
  const [settings] = await ctx.db.select<{ base_url: string }>("ai_settings", "id=eq.1&select=base_url").catch(() => []);
  try {
    const r = await anthropicCheckKey({ baseUrl: settings?.base_url ?? "", apiKey: key });
    return { ok: true as const, models: r.models };
  } catch (e) {
    return { ok: false as const, error: e instanceof AiError ? `ai_${e.code}` : "error", message: e instanceof Error ? e.message.split(key).join("***").slice(0, 300) : "" };
  }
}
