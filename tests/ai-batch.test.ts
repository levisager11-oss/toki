import { describe, expect, it, vi } from "vitest";
import { budgetedBatch, collectBatch } from "../server/ai/batch";
import { SCHEMAS } from "../server/assist/schemas";
import { moderatePrompt, readModerate } from "../server/assist/prompts";
import type { Db } from "../server/db";

/** A database that knows ai_reserve, the two settle functions, and a few rows. */
function fakeDb() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const updates: { table: string; query: string; patch: Record<string, unknown> }[] = [];
  const db = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "ai_reserve") return { id: 9, provider: "anthropic", base_url: "", model: "claude-haiku-5-5", thinking: "low", max_cost: 0.01 };
      return 0;
    },
    async select(table: string) {
      if (table === "ai_settings") return [{ base_url: "" }];
      if (table === "ai_usage") return [{ input_price: 0.1, output_price: 0.5 }];
      return [];
    },
    async update(table: string, query: string, patch: Record<string, unknown>) {
      updates.push({ table, query, patch });
    },
  } as unknown as Db;
  return { db, calls, updates };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const batch = (status: "in_progress" | "ended") => ({
  id: "msgbatch_1", type: "message_batch", processing_status: status,
  request_counts: { processing: status === "ended" ? 0 : 1, succeeded: status === "ended" ? 1 : 0, errored: 0, canceled: 0, expired: 0 },
  results_url: status === "ended" ? "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results" : null,
  created_at: "2026-11-13T00:00:00Z", expires_at: "2026-11-14T00:00:00Z", ended_at: null, cancel_initiated_at: null, archived_at: null,
});
const result = (text: string) => ({
  custom_id: "toki-9",
  result: {
    type: "succeeded",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 } },
  },
});

describe("AI calls as batches", () => {
  it("reserves the call, then sends it as a batch with the feature's model and effort", async () => {
    const { db, calls } = fakeDb();
    const f = vi.fn(async () => json(batch("in_progress"))) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const b = await budgetedBatch({ db, keys: { openai_compatible: "", anthropic: "sk-ant" }, userId: "u", feature: "learn", messages: [{ role: "system", content: "Learn" }, { role: "user", content: "files" }], maxTokens: 16000, fetchImpl: f });
    expect(b).toEqual({ usageId: 9, batchId: "msgbatch_1" });
    expect(calls[0].fn).toBe("ai_reserve");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/v1/messages/batches");
    const sent = JSON.parse(String(init.body));
    expect(sent.requests[0]).toMatchObject({
      custom_id: "toki-9",
      params: { model: "claude-haiku-5-5", max_tokens: 16000, system: [{ type: "text", text: "Learn" }], output_config: { effort: "low" } },
    });
  });

  it("frees the reservation when Anthropic won't take the batch", async () => {
    const { db, calls } = fakeDb();
    const f = vi.fn(async () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401)) as unknown as typeof fetch;
    await expect(budgetedBatch({ db, keys: { openai_compatible: "", anthropic: "bad" }, userId: "u", feature: "learn", messages: [{ role: "user", content: "x" }], maxTokens: 10, fetchImpl: f })).rejects.toMatchObject({ code: "bad_key" });
    expect(calls.at(-1)).toEqual({ fn: "ai_settle", args: { p_id: 9, p_input_tokens: 0, p_output_tokens: 0, p_ok: false } });
  });

  it("waits while the batch runs, then settles half the price and returns the answer", async () => {
    const { db, calls, updates } = fakeDb();
    const waiting = vi.fn(async () => json(batch("in_progress"))) as unknown as typeof fetch;
    expect(await collectBatch(db, "sk-ant", { usageId: 9, batchId: "msgbatch_1", startedAt: Date.now() }, waiting)).toEqual({ state: "waiting" });
    expect(calls).toEqual([]);

    const ended = vi.fn(async (url: string) =>
      String(url).endsWith("/results")
        ? new Response(`${JSON.stringify(result("The guide"))}\n`, { status: 200, headers: { "content-type": "application/binary" } })
        : json(batch("ended")),
    ) as unknown as typeof fetch;
    const r = await collectBatch(db, "sk-ant", { usageId: 9, batchId: "msgbatch_1", startedAt: Date.now() }, ended);
    // 1000 × $0.1 + 200 × $0.5 per million, halved
    expect(r).toEqual({ state: "done", text: "The guide", cost: 0.0001 });
    expect(calls).toEqual([{ fn: "ai_settle_amount", args: { p_id: 9, p_cost: 0.0001, p_ok: true } }]);
    expect(updates[0]).toMatchObject({ table: "ai_usage", patch: { input_tokens: 1000, output_tokens: 200 } });
  });

  it("gives up on a batch that never finished", async () => {
    const { db, calls } = fakeDb();
    const f = vi.fn(async () => json(batch("in_progress"))) as unknown as typeof fetch;
    const r = await collectBatch(db, "sk-ant", { usageId: 9, batchId: "msgbatch_1", startedAt: Date.now() - 26 * 3600_000 }, f);
    expect(r).toEqual({ state: "failed", error: "ai_timeout" });
    expect(calls).toEqual([{ fn: "ai_settle_amount", args: { p_id: 9, p_cost: 0, p_ok: false } }]);
  });
});

describe("structured outputs", () => {
  it("only uses shapes structured outputs accept: every object closed, every field required", () => {
    const check = (s: Record<string, unknown>, path: string) => {
      if (s.type === "object") {
        expect(s.additionalProperties, path).toBe(false);
        expect(s.required, path).toEqual(Object.keys(s.properties as object));
        for (const [k, v] of Object.entries(s.properties as Record<string, Record<string, unknown>>)) check(v, `${path}.${k}`);
      }
      if (s.type === "array") check(s.items as Record<string, unknown>, `${path}[]`);
    };
    for (const [name, s] of Object.entries(SCHEMAS)) check(s, name);
  });
});

describe("a first look at reports", () => {
  it("lists the reports as data, with Toki's rules", () => {
    const [system, user] = moderatePrompt([{ kind: "message", category: "", reason: "rude", text: "you are bad" }, { kind: "profile", category: "harassment", reason: "", text: "Username: x" }], "de");
    expect(system.content).toContain("No insults");
    expect(system.content).toContain("German");
    expect(system.cache).toBe(true);
    expect(user.content).toContain("1. Reported message");
    expect(user.content).toContain("The reporter wrote: rude");
    expect(user.content).toContain("2. Reported profile (reason chosen: harassment)");
  });

  it("keeps only verdicts for reports in the list", () => {
    const v = readModerate('{"verdicts":[{"n":1,"verdict":"remove","reason":"Insult"},{"n":1,"verdict":"keep","reason":"again"},{"n":5,"verdict":"keep","reason":"x"},{"n":2,"verdict":"maybe","reason":"x"}]}', 2);
    expect([...v]).toEqual([[0, { verdict: "remove", reason: "Insult" }]]);
    expect(readModerate("nope", 2).size).toBe(0);
  });
});
