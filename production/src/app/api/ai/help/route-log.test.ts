/**
 * /api/ai/help — R-2778: every question and every tool run is noted in the assistant log.
 * The model is mocked (no AI provider is called); the log call is the person's own client's
 * rpc("log_ai_assistant_event"). Question first (it is the proof the "AI on behalf of" marker
 * looks for), then the tool rows, then the answer row — on the old R-421 path and on the
 * HELP_AI_V2 registry path — and a log that fails never changes the answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";

const db = vi.hoisted(() => ({ role: "owner" as string, rpc: [] as { fn: string; args: Record<string, unknown> }[], rpcFails: false }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpc.push({ fn, args });
      if (db.rpcFails) throw new Error("log table is down");
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const rows = (): Record<string, unknown>[] => (table !== "subscriptions" ? [] : [
        { tenant_id: TENANT, status: "active", renewal_date: "2027-05-01", mrr: 150000 },
        { tenant_id: TENANT, status: "active", renewal_date: "2027-06-01", mrr: 50000 },
      ].filter((r) => filters.every(([c, v]) => r[c as keyof typeof r] === v)));
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
        in: () => q, is: () => q, not: () => q, lt: () => q, order: () => q, limit: () => q, range: () => q,
        maybeSingle: async () => ({ data: table === "users" ? { tenant_id: TENANT, full_name: "Pardeep", role: db.role } : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve),
      };
      return q;
    },
  }),
}));

const gem = vi.hoisted(() => ({ answers: [] as unknown[], throwNext: false }));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key-not-real", model: "model-x" }),
  geminiJson: async () => { if (gem.throwNext) { gem.throwNext = false; throw new Error("model blew up"); } return gem.answers.shift() ?? null; },
}));
vi.mock("@/lib/ai/help-facts", () => ({ helpFacts: async () => ({ text: "", customerIds: new Set() }) }));
vi.mock("@/lib/ai/page-test-runs", () => ({ loadLastPageTestRun: async () => null, testHistoryForPrompt: () => null }));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const ask = (text: string) =>
  POST(new Request("https://example.invalid/api/ai/help", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", text }], pagePath: "/leads", mode: "chat" }),
  }) as unknown as NextRequest);

const REPLY = { reply: "2 subscription chal rahe hain.", actions: [], checklist: [], followUps: [] };
const rows = () => db.rpc.map((c) => c.args);

beforeEach(() => { db.role = "owner"; db.rpc = []; db.rpcFails = false; gem.answers = []; delete process.env.HELP_AI_V2; });
afterEach(() => { delete process.env.HELP_AI_V2; vi.restoreAllMocks(); });

describe("POST /api/ai/help — assistant log (R-2778)", () => {
  it("old path: question (started), the tool run, then the answer with the model — one conversation", async () => {
    gem.answers = [{ tools: ["active_subscriptions"] }, REPLY];
    const body = await (await ask("kitne subscription chal rahe hai, mail boss@example.com")).json();
    expect(body.reply).toBe(REPLY.reply);
    expect(db.rpc.every((c) => c.fn === "log_ai_assistant_event")).toBe(true);
    expect(rows().map((r) => [r.p_kind, r.p_tool ?? null, r.p_outcome])).toEqual([
      ["question", null, "started"], ["tool", "active_subscriptions", "did"], ["answer", null, "did"],
    ]);
    expect(new Set(rows().map((r) => r.p_conversation_id)).size).toBe(1);
    expect(String(rows()[0].p_text)).not.toContain("boss@example.com");
    expect(rows()[2].p_model).toBe("model-x");
    expect(JSON.stringify(rows())).not.toMatch(/tenant|1,50,000|150000/); // no tenant argument, no numbers or rows
  });

  it("registry path (HELP_AI_V2, owner): the runner's calls are logged with a tier and a time", async () => {
    process.env.HELP_AI_V2 = "1";
    gem.answers = [{ tools: ["active_subscriptions"] }, REPLY];
    await (await ask("kitne subscription chal rahe hai")).json();
    const t = rows().filter((r) => r.p_kind === "tool");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ p_tool: "active_subscriptions", p_tier: "read", p_outcome: "did" });
    expect(typeof t[0].p_duration_ms).toBe("number");
    expect(rows()[0].p_kind).toBe("question");
    expect(rows()[rows().length - 1]).toMatchObject({ p_kind: "answer", p_outcome: "did" });
  });

  it("no answer from the model → question + answer(failed); the person still gets the plain unavailable text", async () => {
    gem.answers = [null];
    const body = await (await ask("how do I add a customer")).json();
    expect(body.ai).toBe(false);
    expect(rows().map((r) => [r.p_kind, r.p_outcome])).toEqual([["question", "started"], ["answer", "failed"]]);
  });

  it("the model call throwing still ends the log (question + answer failed) and the error goes on", async () => {
    gem.throwNext = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ask("how do I add a customer")).rejects.toThrow("model blew up");
    expect(rows().map((r) => [r.p_kind, r.p_outcome])).toEqual([["question", "started"], ["answer", "failed"]]);
  });

  it("a log that is down never changes the answer", async () => {
    db.rpcFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    gem.answers = [{ tools: ["active_subscriptions"] }, REPLY];
    const res = await ask("kitne subscription chal rahe hai");
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe(REPLY.reply);
  });
});
