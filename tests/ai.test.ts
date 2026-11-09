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
      db, apiKey: "k", userId: "u", feature: "connect", jobId: "j", maxTokens: 100,
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
    await expect(budgetedCompletion({ db, apiKey: "k", userId: "u", feature: "connect", messages: [], maxTokens: 1, fetchImpl: f })).rejects.toThrow("quota_reached");
    expect(f).not.toHaveBeenCalled();
  });

  it("settles a failed call as failed, counting what was sent", async () => {
    const { db, calls } = fakeDb();
    await expect(budgetedCompletion({ db, apiKey: "k", userId: "u", feature: "connect", messages: [{ role: "user", content: "abc" }], maxTokens: 1, fetchImpl: reply({}, 500) })).rejects.toBeInstanceOf(AiError);
    expect(calls[1].args).toMatchObject({ p_ok: false, p_output_tokens: 0, p_input_tokens: 11 });
  });

  it("needs the API key", async () => {
    const { db, calls } = fakeDb();
    await expect(budgetedCompletion({ db, apiKey: "", userId: "u", feature: "test", messages: [], maxTokens: 1 })).rejects.toMatchObject({ code: "not_configured" });
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
