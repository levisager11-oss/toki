import { describe, expect, it } from "vitest";
import { agentStep, CHANGES_COMMAND, kickoff, readChanges, AGENT_SYSTEM, type AgentDeps, type AgentEvent } from "../server/connect/managed";
import type { Job } from "../server/connect/agent";

const newJob = (over: Partial<Job> = {}): Job => ({
  id: "0b6a0f3e-1111-4222-8333-444455556666",
  repo: "me/run",
  features: ["saves", "scores"],
  notes: "",
  status: "working",
  messages: [],
  state: { lang: "en" },
  game: { title: "Run", score_order: "high", score_format: "points" },
  ...over,
});

/** A fake agent session: events and status that the test sets. */
function fake(init: { events?: AgentEvent[]; status?: "idle" | "running" | "terminated"; cost?: number; changes?: string | null } = {}) {
  const calls: string[] = [];
  const prs: { title: string; body: string; files: Record<string, string> }[] = [];
  const s = { events: init.events ?? [], status: init.status ?? "running", cost: init.cost ?? 0.12, changes: init.changes ?? null };
  const deps: AgentDeps = {
    origin: "https://toki.example",
    script: async () => "/* toki-save */",
    start: async (text) => {
      calls.push(`start:${text.length > 0}`);
      return "sesn_1";
    },
    status: async () => ({ status: s.status, cost: s.cost }),
    events: async () => s.events,
    reply: async (_id, toolUseId, text) => void calls.push(`reply:${toolUseId}:${text}`),
    message: async (_id, text) => void calls.push(`message:${text}`),
    interrupt: async () => void calls.push("interrupt"),
    changes: async () => s.changes,
    openPullRequest: async (p) => {
      prs.push(p);
      return "https://github.com/me/run/pull/2";
    },
    wait: async () => void calls.push("wait"),
    now: () => new Date("2026-11-12T10:00:00Z"),
  };
  return { deps, calls, prs, s };
}

describe("Toki Connect with Managed Agents", () => {
  it("keeps its instructions short and cheap", () => {
    expect(AGENT_SYSTEM.length).toBeLessThan(1600);
    expect(AGENT_SYSTEM).toMatch(/cheap/);
    expect(AGENT_SYSTEM).toMatch(/Don't install/);
    const text = kickoff(newJob({ notes: "Score = coins" }), "/* toki-save */", "de");
    expect(text).toContain("Score = coins");
    expect(text).toContain("German");
    expect(text).toContain(CHANGES_COMMAND);
  });

  it("starts the session with the task", async () => {
    const f = fake();
    const r = await agentStep(newJob(), f.deps);
    expect(r).toMatchObject({ status: "working", state: { session: "sesn_1" } });
    expect(r.messages.at(-1)).toMatchObject({ kind: "progress", step: "agent" });
  });

  it("passes the agent's questions to the developer, and the answers back", async () => {
    const f = fake({ status: "idle", events: [{ type: "custom_tool_use", id: "ev1", name: "ask_developer", input: { message: "Kurz", questions: [{ id: "q1", text: "Was zählt?" }] } }] });
    let job = newJob({ state: { lang: "de", session: "sesn_1" } });
    const r1 = await agentStep(job, f.deps);
    expect(r1.status).toBe("question");
    expect(r1.state.pendingAsk).toBe("ev1");
    job = { ...job, ...r1, status: "working", messages: [...r1.messages, { from: "developer", kind: "answer", answers: [{ id: "q1", question: "Was zählt?", answer: "Münzen" }], at: "x" }] };
    const r2 = await agentStep(job, f.deps);
    expect(r2.status).toBe("working");
    expect(f.calls).toContain("reply:ev1:Was zählt?\n-> Münzen");
    // The same question isn't asked twice.
    const r3 = await agentStep({ ...job, ...r2 }, f.deps);
    expect(r3.status).toBe("working");
  });

  it("opens the pull request with the agent's checked changes, then stops it", async () => {
    const f = fake({
      status: "idle",
      cost: 0.42,
      changes: JSON.stringify({ "index.html": "<script>/* toki */</script>", "src/game.js": "score()" }),
      events: [{ type: "custom_tool_use", id: "ev2", name: "finish", input: { result: "changed", title: "Toki saves", summary: "Added saves." } }],
    });
    const r = await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps);
    expect(r).toMatchObject({ status: "done", pr_url: "https://github.com/me/run/pull/2", cost: 0.42 });
    expect(f.prs[0]).toMatchObject({ title: "Toki saves", files: { "index.html": "<script>/* toki */</script>" } });
    expect(f.calls).toContain("interrupt");
  });

  it("refuses unsafe changes, and asks once more before giving up", async () => {
    const f = fake({ status: "idle", changes: JSON.stringify({ ".github/workflows/x.yml": "evil" }), events: [{ type: "custom_tool_use", id: "ev3", name: "finish", input: { result: "changed", summary: "x" } }] });
    const r1 = await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps);
    expect(r1.status).toBe("working");
    expect(f.calls.some((c) => c.startsWith("reply:ev3:Toki couldn't use your changes"))).toBe(true);
    f.s.events = [...f.s.events, { type: "custom_tool_use", id: "ev4", name: "finish", input: { result: "changed", summary: "x" } }];
    const r2 = await agentStep({ ...newJob(), ...r1 }, f.deps);
    expect(r2).toMatchObject({ status: "failed", error: "ai_bad_edits" });
    expect(f.prs).toEqual([]);
  });

  it("stops when the cap per run is reached", async () => {
    const f = fake({ status: "idle", cost: 1.01, events: [{ type: "idle", stop: "budget_reached" }] });
    expect(await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps)).toMatchObject({ status: "failed", error: "agent_budget", cost: 1.01 });
  });

  it("ends the run when the agent stopped for another reason", async () => {
    const f = fake({ status: "idle", events: [{ type: "idle", stop: "retries_exhausted" }] });
    expect(await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps)).toMatchObject({ status: "failed", error: "ai_provider_error" });
  });

  it("reminds the agent once when it stops without finishing", async () => {
    const f = fake({ status: "idle", events: [{ type: "idle", stop: "end_turn" }] });
    const r1 = await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps);
    expect(r1.status).toBe("working");
    expect(f.calls.some((c) => c.startsWith("message:You stopped without calling finish"))).toBe(true);
    // The same stop again (the reminder isn't picked up yet): no second reminder, no failure.
    const r2 = await agentStep({ ...newJob(), ...r1 }, f.deps);
    expect(r2.status).toBe("working");
    f.s.events = [...f.s.events, { type: "idle", stop: "end_turn" }];
    expect(await agentStep({ ...newJob(), ...r2 }, f.deps)).toMatchObject({ status: "failed", error: "ai_bad_answer" });
  });

  it("waits while the agent works, and says why a session ended", async () => {
    const f = fake({ status: "running" });
    expect((await agentStep(newJob({ state: { session: "sesn_1" } }), f.deps)).status).toBe("working");
    expect(f.calls).toContain("wait");
    const g = fake({ status: "terminated", events: [{ type: "error", message: "container crashed" }] });
    expect(await agentStep(newJob({ state: { session: "sesn_1" } }), g.deps)).toMatchObject({ status: "failed", error_detail: "container crashed" });
  });

  it("checks the changes file", () => {
    expect(readChanges(null)).toEqual({ error: "no changes file" });
    expect(readChanges("nope")).toMatchObject({ error: expect.stringContaining("JSON") });
    expect(readChanges("{}")).toMatchObject({ error: expect.stringContaining("no files") });
    expect(readChanges(JSON.stringify({ "../x": "a" }))).toMatchObject({ error: expect.stringContaining("not allowed") });
    expect(readChanges(JSON.stringify({ "a.js": 1 }))).toMatchObject({ error: expect.stringContaining("not text") });
    expect(readChanges(JSON.stringify({ "a.js": "ok" }))).toEqual({ files: { "a.js": "ok" } });
  });
});
