import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AiError, complete, estimateTokens } from "../server/ai/provider";
import { budgetedCompletion } from "../server/ai/budget";
import { DbError, type Db } from "../server/db";
import { appJwt, GitHubError, type TreeEntry } from "../server/github";
import { applyEdits, parseAiJson, pickFiles, readable, safePath } from "../server/connect/files";
import { errorCode, step, type Deps, type Job, type RepoAccess } from "../server/connect/agent";

const CFG = { provider: "openai_compatible" as const, baseUrl: "https://ai.example/v1/", model: "m1", apiKey: "secret-key" };
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("OpenAI-compatible provider", () => {
  it("asks again with min_p 0 when the server refuses its own default min_p, and remembers that", async () => {
    const cfg = { ...CFG, baseUrl: "https://vllm.example/api", model: "ask-base-nx" };
    const f = vi.fn(async (_url: string, init: RequestInit) =>
      "min_p" in JSON.parse(String(init.body))
        ? new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "The min_p and logit_bias sampling parameters are not yet supported with speculative decoding." } }), { status: 400 }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect((await complete(cfg, { messages: [{ role: "user", content: "hi" }], maxTokens: 16 }, f)).text).toBe("OK");
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((f.mock.calls[1] as [string, RequestInit])[1].body)).min_p).toBe(0);
    // Next time it's sent right away.
    await complete(cfg, { messages: [{ role: "user", content: "hi" }], maxTokens: 16 }, f);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("doesn't send min_p to other endpoints, and doesn't retry other errors", async () => {
    const f = reply({ error: { message: "bad model" } }, 400);
    await expect(complete(CFG, { messages: [{ role: "user", content: "hi" }], maxTokens: 16 }, f)).rejects.toMatchObject({ code: "provider_error" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body)).min_p).toBeUndefined();
  });

  it("sends the chat request and reads the answer and token counts", async () => {
    const f = reply({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 12, completion_tokens: 1 } });
    const c = await complete(CFG, { messages: [{ role: "user", content: "hi" }], maxTokens: 16 }, f);
    expect(c).toEqual({ text: "OK", inputTokens: 12, outputTokens: 1, estimated: false });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "m1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  });

  it("estimates tokens when the endpoint doesn't report them", async () => {
    const c = await complete(CFG, { messages: [{ role: "user", content: "x".repeat(300) }], maxTokens: 16 }, reply({ choices: [{ message: { content: "abcdef" } }] }));
    expect(c).toMatchObject({ inputTokens: 100, outputTokens: 2, estimated: true });
  });

  it("reports errors without leaking the key", async () => {
    const err = await complete(CFG, { messages: [], maxTokens: 1 }, reply({ error: { message: "bad model" } }, 400)).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe("provider_error");
    expect(err.message).toContain("bad model");
    expect(err.message).not.toContain("secret-key");
    await expect(complete({ ...CFG, apiKey: "" }, { messages: [], maxTokens: 1 })).rejects.toMatchObject({ code: "not_configured" });
    await expect(complete(CFG, { messages: [], maxTokens: 1 }, reply({ choices: [{ message: { content: " " } }] }))).rejects.toMatchObject({ code: "empty_answer" });
  });

  it("guesses tokens on the generous side", () => expect(estimateTokens("abcdef")).toBe(2));
});

/** A database that only knows ai_reserve and ai_settle. */
function fakeDb(opts: { refuse?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "ai_reserve") {
        if (opts.refuse) throw new DbError(opts.refuse, 400);
        return { id: 7, provider: "openai_compatible", base_url: "https://ai.example/v1", model: "m1", max_cost: 0.5 };
      }
      if (fn === "ai_settle") return args.p_ok ? 0.01 : 0;
      throw new Error(fn);
    },
  } as unknown as Db;
  return { db, calls };
}

describe("budgeted AI calls", () => {
  it("reserves first, then settles the real token counts", async () => {
    const { db, calls } = fakeDb();
    const c = await budgetedCompletion({
      db, keys: { openai_compatible: "k", anthropic: "" }, userId: "u", feature: "connect", jobId: "j", maxTokens: 100,
      messages: [{ role: "user", content: "x".repeat(30) }],
      fetchImpl: reply({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    });
    expect(c.cost).toBe(0.01);
    expect(calls[0]).toEqual({ fn: "ai_reserve", args: { p_user: "u", p_feature: "connect", p_job: "j", p_input_tokens: 20, p_max_output_tokens: 100 } });
    expect(calls[1]).toEqual({ fn: "ai_settle", args: { p_id: 7, p_input_tokens: 9, p_output_tokens: 3, p_ok: true } });
  });

  it("doesn't call the AI when the budget says no", async () => {
    const { db } = fakeDb({ refuse: "quota_reached" });
    const f = reply({});
    await expect(budgetedCompletion({ db, keys: { openai_compatible: "k", anthropic: "" }, userId: "u", feature: "connect", messages: [], maxTokens: 1, fetchImpl: f })).rejects.toThrow("quota_reached");
    expect(f).not.toHaveBeenCalled();
  });

  it("settles a failed call as failed, counting what was sent", async () => {
    const { db, calls } = fakeDb();
    await expect(budgetedCompletion({ db, keys: { openai_compatible: "k", anthropic: "" }, userId: "u", feature: "connect", messages: [{ role: "user", content: "abc" }], maxTokens: 1, fetchImpl: reply({}, 500) })).rejects.toBeInstanceOf(AiError);
    expect(calls[1].args).toMatchObject({ p_ok: false, p_output_tokens: 0, p_input_tokens: 11 });
  });

  it("needs the API key", async () => {
    const { db, calls } = fakeDb();
    await expect(budgetedCompletion({ db, keys: { openai_compatible: "", anthropic: "" }, userId: "u", feature: "test", messages: [], maxTokens: 1 })).rejects.toMatchObject({ code: "not_configured" });
    expect(calls).toEqual([]);
  });
});

describe("GitHub App token", () => {
  it("is a JWT signed with the app's private key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = appJwt("12345", pem, 1_000_000);
    const [head, body, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    expect(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("which files the AI reads", () => {
  const tree: TreeEntry[] = [
    { path: "index.html", type: "blob", size: 2000 },
    { path: "src/game.js", type: "blob", size: 9000 },
    { path: "src/save.js", type: "blob", size: 1000 },
    { path: "node_modules/x/index.js", type: "blob", size: 100 },
    { path: "dist/bundle.js", type: "blob", size: 100 },
    { path: "lib/phaser.min.js", type: "blob", size: 100 },
    { path: "assets/hero.png", type: "blob", size: 100 },
    { path: "package-lock.json", type: "blob", size: 100 },
    { path: "huge.js", type: "blob", size: 900_000 },
    { path: "src", type: "tree" },
  ];
  it("skips dependencies, builds, images, lock files and huge files", () => {
    expect(tree.filter(readable).map((e) => e.path)).toEqual(["index.html", "src/game.js", "src/save.js"]);
  });
  it("reads the page and save code first", () => expect(pickFiles(tree)).toEqual(["index.html", "src/save.js", "src/game.js"]));
});

describe("paths the AI may write", () => {
  it.each(["index.html", "src/a.js", "export_presets.cfg"])("allows %s", (p) => expect(safePath(p)).toBe(true));
  it.each(["/etc/passwd", "../x", "a/../../b", ".github/workflows/x.yml", ".git/config", "a//b", "a\\b", ""])("refuses %s", (p) => expect(safePath(p)).toBe(false));
});

describe("applying the AI's edits", () => {
  const files = { "index.html": "<head>\n<title>G</title>\n</head>", "a.js": "x = 1;\nx = 1;" };
  it("replaces exact text and writes new files", () => {
    const r = applyEdits(files, [
      { path: "index.html", search: "<head>", replace: "<head>\n<script>t</script>" },
      { path: "index.html", search: "<title>G</title>", replace: "<title>Game</title>" },
      { path: "toki.js", content: "new" },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual({ "index.html": "<head>\n<script>t</script>\n<title>Game</title>\n</head>", "toki.js": "new" });
  });
  it("refuses text that isn't there or appears twice, unread files and unsafe paths", () => {
    expect(applyEdits(files, [{ path: "index.html", search: "<body>", replace: "" }]).errors[0]).toMatch(/not found/);
    expect(applyEdits(files, [{ path: "a.js", search: "x = 1;", replace: "y" }]).errors[0]).toMatch(/more than once/);
    expect(applyEdits(files, [{ path: "other.js", search: "a", replace: "b" }]).errors[0]).toMatch(/read the file/);
    expect(applyEdits(files, [{ path: ".github/workflows/x.yml", content: "evil" }]).errors[0]).toMatch(/not allowed/);
    expect(applyEdits(files, []).errors).toEqual(["no edits"]);
    expect(applyEdits(files, [{ path: "a.js", content: files["a.js"] }]).errors).toEqual(["the edits change nothing"]);
  });
  it("changes nothing when any edit fails", () => {
    const r = applyEdits(files, [{ path: "toki.js", content: "ok" }, { path: "index.html", search: "nope", replace: "" }]);
    expect(r.changed).toEqual({});
  });
});

describe("reading the AI's answer", () => {
  it("finds the JSON object, also in a code block or with text around it", () => {
    expect(parseAiJson('{"action":"read"}')).toEqual({ action: "read" });
    expect(parseAiJson('Sure!\n```json\n{"action":"ask"}\n```')).toEqual({ action: "ask" });
    expect(parseAiJson('Here: {"a": {"b": 1}} done')).toEqual({ a: { b: 1 } });
  });
  it("refuses anything else", () => {
    expect(() => parseAiJson("no json")).toThrow();
    expect(() => parseAiJson("[1,2]")).toThrow();
  });
});

/** A repository in memory, and an AI that answers from a list. */
function fixture(answers: string[], files: Record<string, string> = { "index.html": "<html>\n<head>\n<title>Run</title>\n</head>\n<body><script src=\"game.js\"></script></body>\n</html>", "game.js": "function gameOver(points) {\n  showScreen('over');\n}" }) {
  const prs: { base: string; branch: string; files: Record<string, string>; title: string; body: string }[] = [];
  const repo: RepoAccess = {
    defaultBranch: async () => "main",
    tree: async () => Object.entries(files).map(([path, c]) => ({ path, type: "blob" as const, size: c.length })),
    read: async (p) => files[p],
    openPullRequest: async (p) => {
      prs.push(p);
      return "https://github.com/me/run/pull/1";
    },
  };
  const prompts: string[] = [];
  const deps: Deps = {
    origin: "https://toki.example",
    repo: async () => repo,
    ai: async (messages) => {
      prompts.push(messages.map((m) => m.content).join("\n"));
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      return next;
    },
    script: async () => "/* toki-save */",
    now: () => new Date("2026-11-10T10:00:00Z"),
  };
  return { deps, prs, prompts };
}
const newJob = (over: Partial<Job> = {}): Job => ({ id: "0b6a0f3e-1111-4222-8333-444455556666", repo: "me/run", features: ["saves", "scores"], notes: "", status: "working", messages: [], state: { lang: "de" }, game: { title: "Run", score_order: "high", score_format: "points" }, ...over });

describe("Toki Connect run", () => {
  it("reads the repo, asks the developer, then opens a pull request with the changes", async () => {
    const f = fixture([
      JSON.stringify({ action: "ask", message: "Kurze Frage", questions: [{ id: "q1", text: "Was zählt als Punkte?", options: ["Distanz", "Münzen"] }] }),
      JSON.stringify({
        action: "change",
        title: "Toki-Speicherstände und Highscores",
        summary: "Skript eingebaut, Punkte werden am Ende gesendet.",
        edits: [
          { path: "index.html", search: "<head>", replace: "<head>\n<script>/* toki-save */</script>" },
          { path: "game.js", search: "  showScreen('over');", replace: "  window.toki?.score(points);\n  showScreen('over');" },
        ],
      }),
    ]);
    let job = newJob();
    const r1 = await step(job, f.deps);
    expect(r1.status).toBe("question");
    expect(r1.messages.map((m) => m.kind)).toEqual(["progress", "question"]);
    expect(f.prompts[0]).toContain('<file path="index.html">');
    expect(f.prompts[0]).toContain("German");
    expect(f.prompts[0]).toContain("HIGHER score as better");

    job = { ...job, ...r1, status: "working", messages: [...r1.messages, { from: "developer", kind: "answer", answers: [{ id: "q1", question: "Was zählt als Punkte?", answer: "Distanz" }], at: "x" }] };
    const r2 = await step(job, f.deps);
    expect(r2).toMatchObject({ status: "done", pr_url: "https://github.com/me/run/pull/1", error: null });
    expect(f.prompts[1]).toContain("(q1) Distanz");
    expect(f.prs).toHaveLength(1);
    expect(f.prs[0]).toMatchObject({ base: "main", branch: "toki-connect/0b6a0f3e", title: "Toki-Speicherstände und Highscores" });
    expect(f.prs[0].files["game.js"]).toContain("window.toki?.score(points);");
    expect(f.prs[0].files["index.html"]).toContain("<script>/* toki-save */</script>");
    expect(r2.state.files).toEqual({});
  });

  it("reads more files when the AI asks for them, but only from the repo", async () => {
    const f = fixture([JSON.stringify({ action: "read", paths: ["game.js", "../secret", "nope.js"] })], { "index.html": "x", "game.js": "y" });
    // game.js was already read in the first step, so nothing new is left to read
    const r = await step(newJob(), f.deps);
    expect(r.status).toBe("working");
    expect(r.state.feedback).toMatch(/don't exist|already read/);
  });

  it("tells the AI when its edits don't apply, and gives up after a few tries", async () => {
    const bad = JSON.stringify({ action: "change", title: "x", summary: "x", edits: [{ path: "game.js", search: "not in file", replace: "z" }] });
    const f = fixture([bad, bad, bad]);
    let job = newJob();
    let r = await step(job, f.deps);
    expect(r.status).toBe("working");
    expect(r.state.feedback).toMatch(/not found/);
    job = { ...job, ...r };
    r = await step(job, f.deps);
    job = { ...job, ...r };
    r = await step(job, f.deps);
    expect(r).toMatchObject({ status: "failed", error: "ai_bad_edits" });
    expect(f.prs).toEqual([]);
  });

  it("asks again when the answer isn't JSON", async () => {
    const f = fixture(["I think you should add a script."]);
    const r = await step(newJob(), f.deps);
    expect(r.status).toBe("working");
    expect(r.state.feedback).toMatch(/valid JSON/);
  });

  it("stops when the AI says it can't be done", async () => {
    const f = fixture([JSON.stringify({ action: "impossible", reason: "Das Repo enthält nur ein fertiges Build." })]);
    const r = await step(newJob(), f.deps);
    expect(r).toMatchObject({ status: "failed", error: "impossible" });
    expect(r.messages.at(-1)).toMatchObject({ kind: "impossible", text: "Das Repo enthält nur ein fertiges Build." });
  });

  it("stops with the reason when the budget is used up", async () => {
    const f = fixture([]);
    f.deps.ai = async () => {
      throw new DbError("quota_reached", 400);
    };
    expect(await step(newJob(), f.deps)).toMatchObject({ status: "failed", error: "quota_reached" });
  });

  it("limits the number of AI calls per run", async () => {
    const f = fixture([]);
    const r = await step(newJob({ state: { lang: "en", branch: "main", paths: [], files: {}, aiCalls: 8 } }), f.deps);
    expect(r).toMatchObject({ status: "failed", error: "too_many_steps" });
  });
});

describe("error codes", () => {
  it("names budget, AI and GitHub problems", () => {
    expect(errorCode(new DbError("cap_reached", 400))).toBe("cap_reached");
    expect(errorCode(new DbError("something else", 500))).toBe("error");
    expect(errorCode(new AiError("timeout"))).toBe("ai_timeout");
    expect(errorCode(new GitHubError("x", 404))).toBe("github_not_found");
    expect(errorCode(new GitHubError("x", 500))).toBe("github_error");
  });
});

describe("stored secrets", async () => {
  const { decrypt, encrypt, githubFromManifestCode, githubManifest, withSecrets } = await import("../server/secrets");
  const env = (over: Partial<import("../server/env").ServerEnv> = {}) => ({
    aiKey: "", anthropicKey: "", serviceKey: "sb_secret_one",
    github: { appId: "", slug: "", privateKey: "", clientId: "", clientSecret: "" }, ...over,
  });
  const dbWith = (rows: { name: string; value: string }[]) => ({ select: async () => rows }) as unknown as Db;
  const app = { appId: "1", slug: "toki-connect", privateKey: "PEM", clientId: "cid", clientSecret: "cs" };

  it("are encrypted, and only the same Supabase key opens them", () => {
    const stored = encrypt("my-ai-key", "sb_secret_one");
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("my-ai-key");
    expect(encrypt("my-ai-key", "sb_secret_one")).not.toBe(stored); // a new random start each time
    expect(decrypt(stored, "sb_secret_one")).toBe("my-ai-key");
    expect(decrypt(stored, "sb_secret_two")).toBeNull();
    expect(decrypt(stored.slice(0, -4) + "AAAA", "sb_secret_one")).toBeNull();
    expect(decrypt("garbage", "sb_secret_one")).toBeNull();
  });

  it("fill in what Vercel doesn't have, and say where it came from", async () => {
    const db = dbWith([{ name: "ai_api_key", value: encrypt("stored-key", "sb_secret_one") }, { name: "github_app", value: encrypt(JSON.stringify(app), "sb_secret_one") }]);
    const r = await withSecrets(db, env());
    expect(r.env.aiKey).toBe("stored-key");
    expect(r.env.github).toEqual(app);
    expect(r.sources).toEqual({ aiKey: "toki", anthropicKey: null, github: "toki" });
  });

  it("let Vercel's settings win", async () => {
    const db = dbWith([{ name: "ai_api_key", value: encrypt("stored-key", "sb_secret_one") }]);
    const r = await withSecrets(db, env({ aiKey: "env-key" }));
    expect(r.env.aiKey).toBe("env-key");
    expect(r.sources.aiKey).toBe("env");
  });

  it("count as not set up when they can't be opened", async () => {
    const db = dbWith([{ name: "ai_api_key", value: encrypt("stored-key", "an_old_key") }]);
    expect((await withSecrets(db, env())).sources.aiKey).toBeNull();
  });

  it("ask GitHub for an app that only reads code and opens pull requests", () => {
    const m = githubManifest("https://www.playtoki.app");
    expect(m.default_permissions).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
    expect(m.callback_urls).toEqual(["https://www.playtoki.app/connect/github"]);
    expect(m.redirect_url).toBe("https://www.playtoki.app/admin/ai");
    expect(m.request_oauth_on_install).toBe(true);
    expect(m.hook_attributes.active).toBe(false);
  });

  it("take over the new app's credentials from GitHub", async () => {
    const f = reply({ id: 42, slug: "toki-connect", client_id: "cid", client_secret: "cs", pem: "PEM", html_url: "https://github.com/apps/toki-connect" });
    expect(await githubFromManifestCode("abc", f)).toEqual({ appId: "42", slug: "toki-connect", clientId: "cid", clientSecret: "cs", privateKey: "PEM", htmlUrl: "https://github.com/apps/toki-connect" });
    expect(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string])[0]).toBe("https://api.github.com/app-manifests/abc/conversions");
    await expect(githubFromManifestCode("old", reply({ message: "Not Found" }, 404))).rejects.toThrow(/404/);
  });
});

describe("finding models", async () => {
  const { listModels } = await import("../server/ai/provider");
  const { searchModels, tokensShort } = await import("../src/lib/ai");
  const cfg = { provider: "openai_compatible" as const, baseUrl: "https://ai.example/v1/", apiKey: "k" };

  it("reads the OpenAI-style list", async () => {
    const f = reply({ object: "list", data: [{ id: "gpt-b", object: "model" }, { id: "gpt-a", object: "model" }, { id: "" }, { nope: 1 }] });
    expect(await listModels(cfg, f)).toEqual([
      { id: "gpt-a", name: undefined, context: undefined, inputPrice: undefined, outputPrice: undefined },
      { id: "gpt-b", name: undefined, context: undefined, inputPrice: undefined, outputPrice: undefined },
    ]);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai.example/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("takes names, context sizes and prices per million tokens when given (OpenRouter)", async () => {
    const f = reply({ data: [{ id: "anthropic/claude-sonnet", name: "Anthropic: Claude Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } }] });
    expect(await listModels(cfg, f)).toEqual([{ id: "anthropic/claude-sonnet", name: "Anthropic: Claude Sonnet", context: 200000, inputPrice: 3, outputPrice: 15 }]);
  });

  it("reports errors and needs a key", async () => {
    await expect(listModels(cfg, reply({ error: { message: "bad key" } }, 401))).rejects.toMatchObject({ code: "provider_error" });
    await expect(listModels({ ...cfg, apiKey: "" })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("finds models by every word of the search, in any order", () => {
    const models = [{ id: "anthropic/claude-3.7-sonnet" }, { id: "anthropic/claude-3-haiku" }, { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" }];
    expect(searchModels(models, "sonnet claude").map((m) => m.id)).toEqual(["anthropic/claude-3.7-sonnet"]);
    expect(searchModels(models, "CLAUDE").length).toBe(2);
    expect(searchModels(models, "openai gpt").map((m) => m.id)).toEqual(["openai/gpt-4o"]);
    expect(searchModels(models, "  ").length).toBe(3);
    expect(searchModels(models, "llama")).toEqual([]);
  });

  it("writes context sizes short", () => {
    expect(tokensShort(128000)).toBe("128k");
    expect(tokensShort(1_000_000)).toBe("1M");
    expect(tokensShort(1_050_000)).toBe("1.1M");
  });
});

describe("Anthropic provider", () => {
  const cfg = { provider: "anthropic" as const, baseUrl: "", model: "claude-opus-5-5", apiKey: "sk-ant-test" };
  // A streamed answer, as the Messages API sends it.
  const sse = (text: string, stop = "end_turn") => {
    const events: [string, unknown][] = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: cfg.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    return vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };
  const json = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const sent = (f: ReturnType<typeof vi.fn>) => {
    const [url, init] = f.mock.calls[0] as [string | URL | Request, RequestInit];
    return { url: String(url instanceof Request ? url.url : url), body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) };
  };

  it("sends the system text separately, streams, and counts all input tokens", async () => {
    const f = sse("OK");
    const c = await complete(cfg, { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], maxTokens: 64 }, f);
    expect(c).toEqual({ text: "OK", inputTokens: 15, outputTokens: 5, estimated: false });
    const { url, body, headers } = sent(f);
    expect(url).toContain("https://api.anthropic.com/v1/messages");
    expect(headers.get("authorization") ?? headers.get("x-api-key")).toContain("sk-ant-test");
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 64, system: "Be brief.", stream: true, messages: [{ role: "user", content: "hi" }] });
    // This model gets the server-side fallback.
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("leaves the fallback out for other models and uses a custom address", async () => {
    const f = sse("OK");
    await complete({ ...cfg, model: "claude-haiku-4-5", baseUrl: "https://proxy.example" }, { messages: [{ role: "user", content: "hi" }], maxTokens: 64 }, f);
    const { url, body, headers } = sent(f);
    expect(url).toContain("https://proxy.example/v1/messages");
    expect(body.fallbacks).toBeUndefined();
    expect(headers.get("anthropic-beta")).toBeNull();
  });

  it("reports refusals and errors", async () => {
    await expect(complete(cfg, { messages: [{ role: "user", content: "hi" }], maxTokens: 64 }, sse("", "refusal"))).rejects.toMatchObject({ code: "refused" });
    const bad = reply({ type: "error", error: { type: "invalid_request_error", message: "bad model" } }, 400);
    await expect(complete(cfg, { messages: [{ role: "user", content: "hi" }], maxTokens: 64 }, bad)).rejects.toMatchObject({ code: "provider_error" });
    await expect(complete({ ...cfg, apiKey: "" }, { messages: [], maxTokens: 1 })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("lists the models with names, context sizes and known prices", async () => {
    const { listModels } = await import("../server/ai/provider");
    const f = json({
      data: [
        { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 1000000 },
        { type: "model", id: "claude-unknown-9", display_name: "claude-unknown-9", created_at: "2026-09-01T00:00:00Z" },
      ],
      has_more: false,
      first_id: "claude-opus-5-5",
      last_id: "claude-unknown-9",
    });
    expect(await listModels({ provider: "anthropic", baseUrl: "", apiKey: "k" }, f)).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1000000, inputPrice: 4, outputPrice: 20 },
      { id: "claude-unknown-9", name: undefined, context: undefined, inputPrice: undefined, outputPrice: undefined },
    ]);
    expect(sent(f).url).toContain("https://api.anthropic.com/v1/models");
  });
});
