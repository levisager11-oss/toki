// The free AI's small helpers, for every logged-in account: translations, similar feedback,
// "You might like" games; and for developers and admins: release note drafts, game descriptions,
// summaries of the feedback inbox and of developer applications.
//
// Whatever the AI reads comes from the database, never from the request: posts, replies and chat
// messages are read with the account's own login, so row level security decides what it may see.
// Each account may make only so many free calls an hour per feature (ai_free_take).
import { createHash } from "node:crypto";
import { AiError } from "../server/ai/provider.js";
import { freeCompletion, type FreeFeature } from "../server/ai/free.js";
import {
  applicationPrompt, describePrompt, inboxPrompt, plain, readDescribe, readRelease, readSimilar, readSuggest, readTranslation, releasePrompt,
  similarPrompt, suggestPrompt, translatePrompt, type CatalogGame, type InboxPost, type Lang,
} from "../server/assist/prompts.js";
import { linksIn, readPage } from "../server/assist/pages.js";
import { cleanTurns, guideFiles, helpPrompt, learnPrompt, type HelpGame } from "../server/assist/help.js";
import { pickFiles } from "../server/connect/files.js";
import { errorDetail } from "../server/connect/agent.js";
import { DbError, userDb, type Db } from "../server/db.js";
import { githubConfigured } from "../server/env.js";
import { github, GitHubError } from "../server/github.js";
import { body, context, isUuid, json, type Ctx } from "../server/http.js";
import type { ChatMessage } from "../server/ai/provider.js";

// Vercel gives this function a minute; leave room to answer.
const TIMEOUT_MS = 50_000;

export async function POST(request: Request) {
  const ctx = await context(request, ["admin", "creator", "player"]);
  if (ctx instanceof Response) return ctx;
  const b = await body(request);
  const lang: Lang = b.lang === "de" ? "de" : "en";
  const user = userDb(request.headers.get("authorization") ?? "");
  try {
    switch (b.action) {
      case "translate":
        return await translate(ctx, user, b);
      case "similar":
        return await similar(ctx, user, b);
      case "suggest":
        return await suggest(ctx, b, lang);
      case "release":
        return await release(ctx, b, lang);
      case "describe":
        return await describe(ctx, b);
      case "summary":
        return await summary(ctx, b, lang);
      case "application":
        return await application(ctx, b, lang);
      case "help":
        return await help(ctx, b, lang);
      case "help_setup":
        return await helpSetup(ctx, b);
      case "test":
        return await test(ctx);
      default:
        return json({ error: "bad_request" }, 400);
    }
  } catch (e) {
    return failed(e);
  }
}

function failed(e: unknown): Response {
  if (e instanceof DbError && /^(free_off|not_allowed|rate_limited)$/.test(e.message)) return json({ error: e.message }, e.message === "rate_limited" ? 429 : 403);
  if (e instanceof AiError) return json({ error: e.code === "not_configured" ? "free_off" : `ai_${e.code}`, message: errorDetail(e) ?? "" }, 502);
  if (e instanceof GitHubError) return json({ error: "github_error", message: errorDetail(e) ?? "" }, 502);
  return json({ error: "error" }, 500);
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function ask(ctx: Ctx, feature: FreeFeature, messages: ChatMessage[], maxTokens: number, temperature = 0.2): Promise<string> {
  const c = await freeCompletion({ db: ctx.db, apiKey: ctx.env.aiKey, userId: ctx.user.id, feature, messages, maxTokens, temperature, timeoutMs: TIMEOUT_MS });
  return c.text;
}

/** Whether the account may manage this game's feedback and updates (null: Toki itself, admins only). */
async function manages(ctx: Ctx, gameId: string | null): Promise<{ title: string } | null | false> {
  if (!gameId) return ctx.user.role === "admin" ? null : false;
  const [g] = await ctx.db.select<{ title: string; created_by: string | null }>("games", `id=eq.${gameId}&select=title,created_by`);
  if (!g || (g.created_by !== ctx.user.id && ctx.user.role !== "admin")) return false;
  return { title: g.title };
}

// ---------- translations ----------

const KINDS = ["post", "reply", "message", "game"] as const;
type Kind = (typeof KINDS)[number];

/** The texts to translate, read as the account (null: not there, or not theirs to see). */
async function source(user: Db, kind: Kind, id: string): Promise<string[] | null> {
  switch (kind) {
    case "post": {
      const [p] = await user.select<{ title: string; body: string }>("feedback_posts", `id=eq.${id}&select=title,body`);
      return p ? (p.body.trim() ? [p.title, p.body] : [p.title]) : null;
    }
    case "reply": {
      const [r] = await user.select<{ body: string }>("feedback_replies", `id=eq.${id}&select=body`);
      return r ? [r.body] : null;
    }
    case "message": {
      const [m] = await user.select<{ body: string }>("messages", `id=eq.${id}&select=body`);
      return m ? [m.body] : null;
    }
    case "game": {
      const [g] = await user.select<{ description: string }>("games", `id=eq.${id}&select=description`);
      return g?.description.trim() ? [g.description] : null;
    }
  }
}

async function translate(ctx: Ctx, user: Db, b: Record<string, unknown>) {
  const kind = KINDS.find((k) => k === b.kind);
  const id = typeof b.id === "string" || typeof b.id === "number" ? String(b.id) : "";
  const to: Lang = b.to === "de" ? "de" : "en";
  if (!kind || !(kind === "message" ? /^\d{1,18}$/.test(id) : isUuid(id))) return json({ error: "bad_request" }, 400);
  const texts = await source(user, kind, id);
  if (!texts) return json({ error: "not_found" }, 404);
  const h = hash(`${to}\n${JSON.stringify(texts)}`).slice(0, 64);
  const [saved] = await ctx.db.select<{ hash: string; text: string }>("ai_translations", `kind=eq.${kind}&ref=eq.${id}&lang=eq.${to}&select=hash,text`);
  if (saved?.hash === h) {
    try {
      return json({ texts: JSON.parse(saved.text) as string[], cached: true });
    } catch {
      /* translate again */
    }
  }
  const size = texts.join("").length;
  const answer = await ask(ctx, "translate", translatePrompt(texts, to), Math.min(8000, Math.ceil(size / 2) + 1500), 0.1);
  const out = readTranslation(answer, texts);
  if (!out) return json({ error: "ai_bad_answer" }, 502);
  const stored = JSON.stringify(out);
  if (stored.length <= 9000) {
    await ctx.db
      .insert("ai_translations", { kind, ref: id, lang: to, hash: h, text: stored, created_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal")
      .catch(() => {});
  }
  return json({ texts: out, cached: false });
}

// ---------- similar feedback ----------

async function similar(ctx: Ctx, user: Db, b: Record<string, unknown>) {
  const gameId = isUuid(b.game_id) ? b.game_id : null;
  const title = str(b.title, 100);
  const text = str(b.body, 4000);
  const kind = b.kind === "idea" || b.kind === "other" ? b.kind : "bug";
  if (title.length < 3) return json({ error: "bad_request" }, 400);
  // The board as this account sees it (private bug reports only when it may see them).
  const list = await user.select<{ id: string; kind: string; title: string; body: string; vote_count: number }>(
    "feedback_posts",
    `select=id,kind,title,body,vote_count&hidden=eq.false&status=in.(open,planned,in_progress)&${gameId ? `game_id=eq.${gameId}` : "game_id=is.null"}&order=vote_count.desc&limit=150`,
  );
  if (!list.length) return json({ posts: [] });
  const answer = await ask(ctx, "similar", similarPrompt({ kind, title, body: text }, list), 1500, 0);
  const posts = readSimilar(answer, list).map((id) => list.find((p) => p.id === id)!);
  return json({ posts: posts.map((p) => ({ id: p.id, kind: p.kind, title: p.title, vote_count: p.vote_count })) });
}

// ---------- "You might like" ----------

const DAY = 86_400_000;

async function suggest(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  const recent = (Array.isArray(b.recent) ? b.recent : []).filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,40}$/.test(s)).slice(0, 10);
  const [likes, plays, catalog] = await Promise.all([
    ctx.db.select<{ game_id: string }>("game_likes", `visitor=eq.${ctx.user.id}&select=game_id&order=created_at.desc&limit=20`),
    ctx.db.select<{ game_id: string }>("recent_plays", `user_id=eq.${ctx.user.id}&select=game_id&order=played_at.desc&limit=20`),
    ctx.db.select<CatalogGame>("games", "select=id,slug,title,category,description&order=created_at.desc&limit=300"),
  ]);
  const byId = new Map(catalog.map((g) => [g.id, g]));
  const liked = likes.map((l) => byId.get(l.game_id)).filter((g): g is CatalogGame => !!g);
  const seen = new Set(liked.map((g) => g.id));
  const played: CatalogGame[] = [];
  for (const g of [...plays.map((p) => byId.get(p.game_id)), ...recent.map((s) => catalog.find((c) => c.slug === s))]) {
    if (g && !seen.has(g.id)) {
      seen.add(g.id);
      played.push(g);
    }
  }
  const candidates = catalog.filter((g) => !seen.has(g.id)).slice(0, 120);
  if (!seen.size || !candidates.length) return json({ games: [] });

  const basis = hash(`${lang}\n${liked.map((g) => g.id).join(",")}\n${played.map((g) => g.id).join(",")}`).slice(0, 64);
  const [saved] = await ctx.db.select<{ lang: string; basis: string; games: { id: string; slug: string; why: string }[]; created_at: string }>(
    "ai_suggestions",
    `user_id=eq.${ctx.user.id}&select=lang,basis,games,created_at`,
  );
  if (saved && saved.lang === lang) {
    const age = Date.now() - new Date(saved.created_at).getTime();
    // The same basis: good for a day. Something new played: still fine for half an hour.
    if ((saved.basis === basis && age < DAY) || age < DAY / 48) {
      return json({ games: saved.games.filter((g) => byId.has(g.id) && !seen.has(g.id)), cached: true });
    }
  }
  const answer = await ask(ctx, "suggest", suggestPrompt(liked.slice(0, 10), played.slice(0, 10), candidates, lang), 1500, 0.4);
  const games = readSuggest(answer, candidates);
  await ctx.db
    .insert("ai_suggestions", { user_id: ctx.user.id, lang, basis, games, created_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal")
    .catch(() => {});
  return json({ games });
}

// ---------- release notes ----------

async function release(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  const gameId = isUuid(b.game_id) ? b.game_id : null;
  const game = await manages(ctx, gameId);
  if (game === false) return json({ error: "not_allowed" }, 403);
  const gameFilter = gameId ? `game_id=eq.${gameId}` : "game_id=is.null";
  const [last] = await ctx.db.select<{ version: string; published_at: string }>("game_releases", `${gameFilter}&select=version,published_at&order=published_at.desc&limit=1`);
  const fixIds = (Array.isArray(b.fixes) ? b.fixes : []).filter(isUuid).slice(0, 30);
  const fixes = fixIds.length
    ? await ctx.db.select<{ kind: string; title: string }>("feedback_posts", `id=in.(${fixIds.join(",")})&${gameFilter}&select=kind,title`)
    : [];

  // The code's changes since the last update, from a repository the account connected on Toki.
  let commits: string[] = [];
  let commitsError = false;
  const installation = Number(b.installation_id);
  const repo = typeof b.repo === "string" ? b.repo : "";
  if (repo && Number.isSafeInteger(installation) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && githubConfigured(ctx.env.github)) {
    try {
      const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${installation}&select=installation_id`);
      if (!owned) return json({ error: "not_allowed" }, 403);
      const gh = github(ctx.env.github);
      if (!(await gh.repos(installation)).some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return json({ error: "not_allowed" }, 403);
      commits = await (await gh.repo(installation, repo)).commits(last?.published_at);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      commitsError = true;
    }
  }
  const notes = str(b.notes, 1500);
  if (!notes && !fixes.length && !commits.length) return json({ error: "nothing_to_write", commitsError }, 400);
  const answer = await ask(ctx, "release", releasePrompt({ game: game?.title ?? null, lang, notes, fixes, commits, lastVersion: last?.version ?? null }), 2500, 0.3);
  const draft = readRelease(answer);
  if (!draft) return json({ error: "ai_bad_answer" }, 502);
  return json({ ...draft, commits: commits.length, commitsError });
}

// ---------- game descriptions ----------

async function describe(ctx: Ctx, b: Record<string, unknown>) {
  if (ctx.user.role === "player") return json({ error: "not_allowed" }, 403);
  const title = str(b.title, 60);
  if (!title) return json({ error: "bad_request" }, 400);
  const url = str(b.play_url, 500);
  const page = url ? await readPage(url) : null;
  const answer = await ask(
    ctx,
    "describe",
    describePrompt({
      title,
      category: str(b.category, 20) || "other",
      engine: str(b.engine, 30),
      controls: str(b.controls, 500),
      en: str(b.description, 1000),
      de: str(b.description_de, 1000),
      page: page?.ok ? { title: page.title, text: page.text } : null,
    }),
    2000,
    0.5,
  );
  const out = readDescribe(answer);
  return out ? json(out) : json({ error: "ai_bad_answer" }, 502);
}

// ---------- summaries ----------

async function summary(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  if (ctx.user.role === "player") return json({ error: "not_allowed" }, 403);
  let filter = "";
  if (b.game_id === "toki") {
    if (ctx.user.role !== "admin") return json({ error: "not_allowed" }, 403);
    filter = "&game_id=is.null";
  } else if (isUuid(b.game_id)) {
    if ((await manages(ctx, b.game_id)) === false) return json({ error: "not_allowed" }, 403);
    filter = `&game_id=eq.${b.game_id}`;
  } else if (ctx.user.role !== "admin") {
    const games = await ctx.db.select<{ id: string }>("games", `created_by=eq.${ctx.user.id}&select=id`);
    if (!games.length) return json({ text: "" });
    filter = `&game_id=in.(${games.map((g) => g.id).join(",")})`;
  }
  const rows = await ctx.db.select<{ kind: string; title: string; body: string; vote_count: number; reply_count: number; answered: boolean; status: string; game: { title: string } | null }>(
    "feedback_posts",
    `select=kind,title,body,vote_count,reply_count,answered,status,game:games(title)&hidden=eq.false&status=in.(open,planned,in_progress)${filter}&order=vote_count.desc&limit=120`,
  );
  if (!rows.length) return json({ text: "" });
  const posts: InboxPost[] = rows.map((r) => ({
    game: r.game?.title ?? null,
    kind: r.kind,
    title: r.title,
    body: r.body,
    votes: r.vote_count,
    replies: r.reply_count,
    answered: r.answered,
    status: r.status,
  }));
  const answer = await ask(ctx, "summary", inboxPrompt(posts, lang), 2500, 0.2);
  return json({ text: plain(answer, 4000) });
}

async function application(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  if (ctx.user.role !== "admin" || !isUuid(b.id)) return json({ error: "not_allowed" }, 403);
  const [app] = await ctx.db.select<{ about: string; links: string }>("developer_applications", `id=eq.${b.id}&select=about,links`);
  if (!app) return json({ error: "not_found" }, 404);
  const pages = await Promise.all(linksIn(`${app.links}\n${app.about}`).map((u) => readPage(u)));
  const answer = await ask(ctx, "summary", applicationPrompt(app, pages, lang), 1500, 0.2);
  return json({ text: plain(answer, 2000) });
}

// ---------- the game helper ("Ask AI") ----------

async function help(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  const turns = cleanTurns(b.messages);
  if (!turns.length) return json({ error: "bad_request" }, 400);
  let game: HelpGame | null = null;
  if (isUuid(b.game_id)) {
    const [g] = await ctx.db.select<{ title: string; slug: string; category: string; description: string; description_de: string | null; controls: string; author: { username: string } | null }>(
      "games",
      `id=eq.${b.game_id}&select=title,slug,category,description,description_de,controls,author:profiles!games_created_by_fkey(username)`,
    );
    if (!g) return json({ error: "not_found" }, 404);
    const [h] = await ctx.db.select<{ notes: string; guide: string }>("game_help", `game_id=eq.${b.game_id}&select=notes,guide`);
    game = {
      title: g.title,
      slug: g.slug,
      category: g.category,
      description: (lang === "de" && g.description_de) || g.description,
      controls: g.controls,
      author: g.author?.username ?? null,
      notes: h?.notes ?? "",
      guide: h?.guide ?? "",
    };
  }
  const answer = await ask(ctx, "help", helpPrompt(game, turns, lang), 1200, 0.3);
  const text = plain(answer, 3000);
  return text ? json({ text }) : json({ error: "ai_empty_answer" }, 502);
}

/** The developer saves tips for the helper, and lets it learn the game from a repository (once, now). */
async function helpSetup(ctx: Ctx, b: Record<string, unknown>) {
  if (!isUuid(b.game_id)) return json({ error: "bad_request" }, 400);
  if ((await manages(ctx, b.game_id)) === false) return json({ error: "not_allowed" }, 403);
  const notes = str(b.notes, 4000);
  const installation = Number(b.installation_id);
  const repo = typeof b.repo === "string" ? b.repo : "";
  const row: Record<string, unknown> = { game_id: b.game_id, notes, updated_at: new Date().toISOString() };
  if (repo && b.learn !== true) {
    // Only new tips: what it learned stays.
  } else if (!repo) {
    // No repository (any more): only the developer's tips.
    Object.assign(row, { installation_id: null, repo: null, guide: "", learned_at: null });
  } else {
    if (!Number.isSafeInteger(installation) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return json({ error: "bad_request" }, 400);
    if (!githubConfigured(ctx.env.github)) return json({ error: "github_error" }, 503);
    const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${installation}&select=installation_id`);
    if (!owned) return json({ error: "not_allowed" }, 403);
    const gh = github(ctx.env.github);
    if (!(await gh.repos(installation)).some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return json({ error: "not_allowed" }, 403);
    const [g] = await ctx.db.select<{ title: string; description: string; controls: string }>("games", `id=eq.${b.game_id}&select=title,description,controls`);
    const access = await gh.repo(installation, repo);
    const branch = await access.defaultBranch();
    const tree = await access.tree(branch);
    const files: Record<string, string> = {};
    let total = 0;
    for (const p of guideFiles(tree, pickFiles(tree))) {
      if (total >= 60_000) break;
      const c = (await access.read(p, branch)).slice(0, 15_000);
      files[p] = c;
      total += c.length;
    }
    const answer = await ask(ctx, "learn", learnPrompt(g, files), 3000, 0.2);
    const guide = plain(answer, 8000);
    if (!guide) return json({ error: "ai_empty_answer" }, 502);
    Object.assign(row, { installation_id: installation, repo, guide, learned_at: new Date().toISOString() });
  }
  await ctx.db.insert("game_help", row, "resolution=merge-duplicates,return=minimal");
  return json({ ok: true, learned_at: row.learned_at ?? null, guide: row.guide ?? null });
}

// ---------- admins: test the free AI ----------

async function test(ctx: Ctx) {
  if (ctx.user.role !== "admin") return json({ error: "not_allowed" }, 403);
  try {
    const c = await freeCompletion({
      db: ctx.db,
      apiKey: ctx.env.aiKey,
      userId: ctx.user.id,
      feature: "test",
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 1024,
      timeoutMs: TIMEOUT_MS,
    });
    return json({ ok: true, text: c.text.slice(0, 200), inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimated: c.estimated });
  } catch (e) {
    const r = failed(e);
    const out = (await r.json()) as { error: string; message?: string };
    return json({ ok: false, ...out });
  }
}
