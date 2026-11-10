// The free AI's small helpers, for every logged-in account: translations, similar feedback,
// "You might like" games; and for developers and admins: release note drafts, game descriptions,
// summaries of the feedback inbox and of developer applications, and a prompt for a coding AI made
// from a game's feedback.
//
// Whatever the AI reads comes from the database, never from the request: posts, replies and chat
// messages are read with the account's own login, so row level security decides what it may see.
// (Only a player's own words come with the request: their question to the game helper, and their
// own save in that game as this browser has it.)
// Each account may make only so many free calls an hour per feature (ai_free_take).
import { createHash } from "node:crypto";
import { AiError } from "../server/ai/provider.js";
import { freeCompletion, type FreeFeature } from "../server/ai/free.js";
import {
  applicationPrompt, describePrompt, improvePrompt, improveText, inboxPrompt, plain, readDescribe, readImprove, readRelease, readSimilar, readSuggest,
  readTranslation, releasePrompt, similarPrompt, suggestPrompt, translatePrompt, type CatalogGame, type ImprovePost, type InboxPost, type Lang,
} from "../server/assist/prompts.js";
import { linksIn, readPage } from "../server/assist/pages.js";
import { cleanTurns, guideFiles, helpPrompt, learnPrompt, scoreText, type HelpGame, type HelpPlayer } from "../server/assist/help.js";
import { MAX_SAVE_SUMMARY } from "../src/lib/saveSummary.js";
import { pickFiles } from "../server/connect/files.js";
import { errorDetail } from "../server/connect/agent.js";
import { DbError, userDb, type Db } from "../server/db.js";
import { githubConfigured } from "../server/env.js";
import { github, GitHubError } from "../server/github.js";
import { body, context, isUuid, json, type Ctx } from "../server/http.js";
import type { ChatMessage } from "../server/ai/provider.js";
import { basics, gameFolder, readScan, readTokiJson, scanPrompt, withToki, type ScanFile } from "../server/assist/scan.js";
import { freeSettings } from "../server/ai/free.js";

// Vercel gives this function 5 minutes (vercel.json). Players and developers wait for most
// answers, so those get 90 seconds; learning a game from its code may take longer.
const TIMEOUT_MS = 90_000;
const LEARN_TIMEOUT_MS = 280_000;

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
      case "scan":
        return await scan(ctx, b);
      case "summary":
        return await summary(ctx, b, lang);
      case "improve":
        return await improve(ctx, b, lang);
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

/** One call to the free AI, without a token limit (tokens cost nothing there). */
async function ask(ctx: Ctx, feature: FreeFeature, messages: ChatMessage[], temperature = 0.2, timeoutMs = TIMEOUT_MS): Promise<string> {
  const c = await freeCompletion({ db: ctx.db, keys: { free: ctx.env.freeAiKey, openai: ctx.env.aiKey }, userId: ctx.user.id, feature, messages, temperature, timeoutMs });
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
  const answer = await ask(ctx, "translate", translatePrompt(texts, to), 0.1);
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
  const answer = await ask(ctx, "similar", similarPrompt({ kind, title, body: text }, list), 0);
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
  const answer = await ask(ctx, "suggest", suggestPrompt(liked.slice(0, 10), played.slice(0, 10), candidates, lang), 0.4);
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
  const answer = await ask(ctx, "release", releasePrompt({ game: game?.title ?? null, lang, notes, fixes, commits, lastVersion: last?.version ?? null }), 0.3);
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
    0.5,
  );
  const out = readDescribe(answer);
  return out ? json(out) : json({ error: "ai_bad_answer" }, 502);
}

// ---------- one-click add: reading a game ----------

const MAX_SCAN = 150_000;

/**
 * A game's files (sent from the browser for an upload; read from GitHub for a repository) →
 * the details for its page, the folder with the game (repositories), and whether a leaderboard fits.
 */
async function scan(ctx: Ctx, b: Record<string, unknown>) {
  if (ctx.user.role === "player") return json({ error: "not_allowed" }, 403);
  let files: ScanFile[] = [];
  let paths: string[] = [];
  let name = str(b.name, 100);
  let folder: string | null = null;
  let needsBuild = false;

  if (b.source === "github") {
    if (!githubConfigured(ctx.env.github)) return json({ error: "github_off" }, 503);
    const installation = Number(b.installation_id);
    const repoName = str(b.repo, 140);
    const branch = str(b.branch, 200);
    const [owned] = await ctx.db.select("github_installations", `user_id=eq.${ctx.user.id}&installation_id=eq.${installation}&select=installation_id`);
    if (!owned || !/^[\w.-]+\/[\w.-]+$/.test(repoName) || !branch) return json({ error: "not_allowed" }, 403);
    const gh = github(ctx.env.github);
    if (!(await gh.repos(installation)).some((r) => r.repo.toLowerCase() === repoName.toLowerCase())) return json({ error: "not_allowed" }, 403);
    const repo = await gh.repo(installation, repoName);
    const tree = (await repo.tree(branch)).filter((e) => e.type === "blob");
    paths = tree.map((e) => e.path);
    name = repoName.split("/")[1];
    // The start pages and package.json, to find the folder with the playable game.
    const pages = new Map<string, string>();
    const wanted = paths.filter((p) => /(^|\/)index\.html$/i.test(p) && p.split("/").length <= 3).slice(0, 8);
    if (paths.includes("package.json")) wanted.push("package.json");
    for (const p of wanted) pages.set(p, (await repo.read(p, branch).catch(() => "")).slice(0, 60_000));
    ({ folder, needsBuild } = gameFolder(paths, (p) => pages.get(p)));
    const inFolder = folder ? tree.filter((e) => e.path.startsWith(`${folder}/`)).map((e) => ({ ...e, path: e.path.slice(folder!.length + 1) })) : tree;
    let total = 0;
    for (const p of pickFiles(folder === null ? tree : inFolder)) {
      const full = folder ? `${folder}/${p}` : p;
      const t = pages.get(full) ?? (await repo.read(full, branch).catch(() => ""));
      if (total + t.length > MAX_SCAN) continue;
      files.push({ path: p, text: t.slice(0, 60_000) });
      total += t.length;
    }
    const toki = paths.includes("toki.json") ? await repo.read("toki.json", branch).catch(() => "") : "";
    if (toki) files.push({ path: "toki.json", text: toki.slice(0, 20_000) });
  } else {
    // An upload: the browser sends the game's start page and a sample of its code.
    paths = (Array.isArray(b.paths) ? b.paths : []).filter((p): p is string => typeof p === "string").slice(0, 3000).map((p) => p.slice(0, 300));
    let total = 0;
    for (const f of Array.isArray(b.files) ? b.files.slice(0, 40) : []) {
      const path = str((f as ScanFile)?.path, 300);
      const t = typeof (f as ScanFile)?.text === "string" ? (f as ScanFile).text.slice(0, 60_000) : "";
      if (!path || total + t.length > MAX_SCAN) continue;
      files.push({ path, text: t });
      total += t.length;
    }
  }

  const tokiFile = files.find((f) => f.path === "toki.json");
  let proposal = basics(files, name);
  let ai = false;
  if (await freeSettings(ctx.db)) {
    try {
      proposal = readScan(await ask(ctx, "describe", scanPrompt(files, paths, proposal, name), 0.3), proposal);
      ai = true;
    } catch {
      /* the AI is a help here, not a must: the simple checks stay */
    }
  }
  if (tokiFile) proposal = withToki(proposal, readTokiJson(tokiFile.text));
  return json({ proposal, folder, needsBuild, ai });
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
  const answer = await ask(ctx, "summary", inboxPrompt(posts, lang), 0.2);
  return json({ text: plain(answer, 4000) });
}

/**
 * A prompt for an AI that works on the code, from one game's open feedback (or Toki's own, for
 * admins): posts that don't help are sorted out and the same wishes put together.
 */
async function improve(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  if (ctx.user.role === "player") return json({ error: "not_allowed" }, 403);
  let game: { title: string; description: string } | null = null;
  if (b.game_id === "toki") {
    if (ctx.user.role !== "admin") return json({ error: "not_allowed" }, 403);
  } else if (isUuid(b.game_id)) {
    const [g] = await ctx.db.select<{ title: string; description: string; description_de: string | null; created_by: string | null }>(
      "games",
      `id=eq.${b.game_id}&select=title,description,description_de,created_by`,
    );
    if (!g || (g.created_by !== ctx.user.id && ctx.user.role !== "admin")) return json({ error: "not_allowed" }, 403);
    game = { title: g.title, description: (lang === "de" && g.description_de) || g.description };
  } else {
    return json({ error: "bad_request" }, 400);
  }
  // With the developer's latest reply to each post: it often says a post is settled.
  const rows = await ctx.db.select<{ id: string; kind: string; title: string; body: string; device: string | null; vote_count: number; status: string; feedback_replies: { body: string }[] | null }>(
    "feedback_posts",
    `select=id,kind,title,body,device,vote_count,status,feedback_replies(body)&feedback_replies.official=eq.true&feedback_replies.order=created_at.desc&feedback_replies.limit=1` +
      `&hidden=eq.false&status=in.(open,planned,in_progress)&${game ? `game_id=eq.${b.game_id}` : "game_id=is.null"}&order=vote_count.desc,created_at.desc&limit=120`,
  );
  if (!rows.length) return json({ prompt: "", total: 0, used: 0, skipped: [] });
  const posts: ImprovePost[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    votes: r.vote_count,
    status: r.status,
    device: r.device,
    reply: r.feedback_replies?.[0]?.body ?? "",
  }));
  const out = readImprove(await ask(ctx, "summary", improvePrompt(game?.title ?? null, posts, lang), 0.2), posts);
  if (!out) return json({ error: "ai_bad_answer" }, 502);
  return json({ prompt: improveText(game, out.tasks, lang), total: posts.length, used: out.used, skipped: out.skipped });
}

async function application(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  if (ctx.user.role !== "admin" || !isUuid(b.id)) return json({ error: "not_allowed" }, 403);
  const [app] = await ctx.db.select<{ about: string; links: string }>("developer_applications", `id=eq.${b.id}&select=about,links`);
  if (!app) return json({ error: "not_found" }, 404);
  const pages = await Promise.all(linksIn(`${app.links}\n${app.about}`).map((u) => readPage(u)));
  const answer = await ask(ctx, "summary", applicationPrompt(app, pages, lang), 0.2);
  return json({ text: plain(answer, 2000) });
}

// ---------- the game helper ("Ask AI") ----------

async function help(ctx: Ctx, b: Record<string, unknown>, lang: Lang) {
  const turns = cleanTurns(b.messages);
  if (!turns.length) return json({ error: "bad_request" }, 400);
  let game: HelpGame | null = null;
  let player: HelpPlayer | null = null;
  if (isUuid(b.game_id)) {
    const [g] = await ctx.db.select<{ title: string; slug: string; category: string; description: string; description_de: string | null; controls: string; score_format: string; author: { username: string } | null }>(
      "games",
      `id=eq.${b.game_id}&select=title,slug,category,description,description_de,controls,score_format,author:profiles!games_created_by_fkey(username)`,
    );
    if (!g) return json({ error: "not_found" }, 404);
    const mine = `game_id=eq.${b.game_id}&user_id=eq.${ctx.user.id}`;
    // Where the player is: their save as the game page has it, and their best score and playtime.
    const [[h], [best], [time]] = await Promise.all([
      ctx.db.select<{ notes: string; guide: string }>("game_help", `game_id=eq.${b.game_id}&select=notes,guide`),
      ctx.db.select<{ score: number }>("game_scores", `${mine}&select=score`).catch(() => []),
      ctx.db.select<{ seconds: number }>("playtime", `${mine}&select=seconds`).catch(() => []),
    ]);
    const save = str(b.save, MAX_SAVE_SUMMARY);
    const ago = typeof b.saved_at === "number" ? Math.round((Date.now() - b.saved_at) / 1000) : NaN;
    player = {
      save,
      // The time is from the player's device: only used when it makes sense.
      savedAgo: save && ago >= 0 && ago < 400 * 86_400 ? ago : null,
      best: best ? scoreText(Number(best.score), g.score_format) : null,
      seconds: time?.seconds ?? 0,
    };
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
  const answer = await ask(ctx, "help", helpPrompt(game, turns, lang, player), 0.3);
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
      if (total >= 40_000) break;
      const c = (await access.read(p, branch)).slice(0, 12_000);
      files[p] = c;
      total += c.length;
    }
    const answer = await ask(ctx, "learn", learnPrompt(g, files), 0.2, LEARN_TIMEOUT_MS);
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
      keys: { free: ctx.env.freeAiKey, openai: ctx.env.aiKey },
      userId: ctx.user.id,
      feature: "test",
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      timeoutMs: TIMEOUT_MS,
    });
    return json({ ok: true, text: c.text.slice(0, 200), inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimated: c.estimated });
  } catch (e) {
    const r = failed(e);
    const out = (await r.json()) as { error: string; message?: string };
    return json({ ok: false, ...out });
  }
}
