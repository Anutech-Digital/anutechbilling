/**
 * /api/ai/help — R-2775 / H-02: Claude's native tool-use loop behind HELP_AI_V2, owner only.
 * The Anthropic client is mocked (no real API, no key); the database is a fake. Covers the card's
 * doneWhen: a chained two-tool question, refusal, max rounds — and that flag off / another role /
 * no Claude key / non-chat modes / screenshots keep the old path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HELP_INJECTION_CASES } from "@/lib/ai/help-loop-injection-fixture";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const KNOWN_CUSTOMER = "cccccccc-0000-4000-8000-0000000000c1";

const db = vi.hoisted(() => ({ key: "x.eyJyb2xlIjoiYW5vbiJ9.y", role: "owner" as string, rpc: [] as { fn: string; args: Record<string, unknown> }[], uid: "u-1" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    supabaseKey: db.key,
    auth: { getUser: async () => ({ data: { user: { id: db.uid } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => { db.rpc.push({ fn, args }); return { data: null, error: null }; },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const rows = (): Record<string, unknown>[] => (table !== "subscriptions" ? [] : [
        { tenant_id: TENANT, status: "active", renewal_date: "2027-05-01", mrr: 150000 },
        { tenant_id: TENANT, status: "active", renewal_date: "2027-06-01", mrr: 50000 },
      ].filter((r) => filters.every(([c, v]) => r[c as keyof typeof r] === v)));
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
        in: () => q, is: () => q, not: () => q, lt: () => q, lte: () => q, gte: () => q, gt: () => q, neq: () => q, order: () => q, limit: () => q, range: () => q,
        maybeSingle: async () => ({ data: table === "users" ? { tenant_id: TENANT, full_name: "Pardeep", role: db.role } : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve),
      };
      return q;
    },
  }),
}));

const gem = vi.hoisted(() => ({ calls: 0, answers: [] as unknown[] }));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key-not-real", model: "model-x" }),
  geminiJson: async () => { gem.calls++; return gem.answers.shift() ?? null; },
}));
vi.mock("@/lib/ai/help-facts", () => ({ helpFacts: async () => ({ text: "Company facts.", customerIds: new Set(["cccccccc-0000-4000-8000-0000000000c1"]) }) }));
vi.mock("@/lib/ai/page-test-runs", () => ({ loadLastPageTestRun: async () => null, testHistoryForPrompt: () => null }));

const api = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[], opts: [] as Record<string, unknown>[], script: [] as unknown[], throwNext: null as unknown }));
vi.mock("@/lib/ai/claude", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/claude")>()),
  claudeClient: () => ({
    beta: { messages: { create: async (body: Record<string, unknown>, opts: Record<string, unknown>) => {
      api.bodies.push(JSON.parse(JSON.stringify(body))); api.opts.push(opts);
      if (api.throwNext) { const e = api.throwNext; api.throwNext = null; throw e; }
      const next = api.script.shift();
      if (!next) throw new Error("script ran out");
      return next;
    } } },
  }),
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const ask = (text: string, over: Record<string, unknown> = {}) =>
  POST(new Request("https://example.invalid/api/ai/help", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", text }], pagePath: "/leads", mode: "chat", ...over }),
  }) as unknown as NextRequest);

const msg = (stop_reason: string, content: unknown[], usage = { input_tokens: 100, output_tokens: 20 }) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason, content, usage });
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const final = (o: Record<string, unknown>) => msg("end_turn", [{ type: "text", text: JSON.stringify(o) }]);
const REPLY = { reply: "2 subscription chal rahe hain, 1 agle 30 din mein renew.", actions: [], checklist: [], followUps: [] };

beforeEach(() => {
  db.key = "x.eyJyb2xlIjoiYW5vbiJ9.y"; db.role = "owner"; db.rpc = []; db.uid = `u-${Math.random()}`;
  gem.calls = 0; gem.answers = [];
  api.bodies = []; api.opts = []; api.script = []; api.throwNext = null;
  process.env.HELP_AI_V2 = "on";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.ANTHROPIC_MODEL;
});
afterEach(() => { delete process.env.HELP_AI_V2; delete process.env.ANTHROPIC_API_KEY; vi.restoreAllMocks(); });

describe("HELP_AI_V2 on, owner: the native tool-use loop", () => {
  it("chained question: two tools in round 1, the answer in round 2 — numbers, links, sources, the Gemini door never used", async () => {
    api.script = [
      msg("tool_use", [{ type: "thinking", thinking: "", signature: "sig" }, toolUse("tu_a", "active_subscriptions"), toolUse("tu_b", "renewals_due")]),
      final({ ...REPLY, actions: [{ kind: "open", label: "Open active subscriptions", href: "/subscriptions" }] }),
    ];
    const res = await ask("kitne subscription chal rahe hai aur kitne agle 30 din mein renew hone hai");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ai).toBe(true);
    expect(body.reply).toBe(REPLY.reply);
    expect(gem.calls).toBe(0);
    const hrefs = body.actions.map((a: { href: string }) => a.href);
    expect(hrefs).toContain("/subscriptions?focus=active"); // a link for EACH number's page (same path, different tab), added even if the model forgot one
    expect(hrefs).toContain("/subscriptions?tab=expiring");
    expect(body.actions.every((a: { href: string }) => a.href.startsWith("/"))).toBe(true);
    expect((body.sources as unknown[]).length).toBeGreaterThanOrEqual(2);

    expect(api.bodies).toHaveLength(2);
    const first = api.bodies[0];
    expect(first.model).toBe("claude-opus-5-5");
    // request rules of the model: no thinking, no sampling params, effort low, tool_choice auto + strict tools, server-side fallbacks default
    expect(first).not.toHaveProperty("thinking");
    expect(first).not.toHaveProperty("temperature");
    expect(first).not.toHaveProperty("top_p");
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect(first.fallbacks).toBe("default");
    const tools = first.tools as { name: string; strict: boolean; input_schema: { additionalProperties: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["active_subscriptions", "find_customer", "leads_by_stage", "list_invoices", "open_quotes", "overdue_invoices", "renewals_due", "todays_followups"]);
    expect(tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    expect(String(first.system)).toContain("UNTRUSTED DATA");
    expect(String(first.system)).toContain("DATA TOOLS:");
    // round 2: the model's own message replayed unchanged, ALL results in ONE user message, every result wrapped
    const m2 = api.bodies[1].messages as { role: string; content: unknown }[];
    expect(m2.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((m2[1].content as { type: string }[])[0].type).toBe("thinking");
    const results = m2[2].content as { type: string; tool_use_id: string; content: string }[];
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([["tool_result", "tu_a"], ["tool_result", "tu_b"]]);
    expect(results[0].content).toContain("Active subscriptions: 2");
    expect(results.every((r) => r.content.includes("<<<UNTRUSTED_DATA id=") && r.content.includes("<<<END_UNTRUSTED_DATA id="))).toBe(true);
    expect(api.opts.every((o) => typeof o.timeout === "number" && (o.timeout as number) <= 60_000)).toBe(true);
  });

  it("logs the question, each tool call (name, outcome) and the answer with the model name and tokens", async () => {
    api.script = [msg("tool_use", [toolUse("tu_a", "active_subscriptions"), toolUse("tu_x", "nope_tool")]), final(REPLY)];
    await ask("kitne subscription");
    const rows = db.rpc.map((c) => c.args);
    const byName = (a: unknown[], b: unknown[]) => String(a[1]).localeCompare(String(b[1]));
    const seq = rows.map((r) => [r.p_kind, r.p_tool ?? null, r.p_outcome]);
    expect([seq[0], ...seq.slice(1, 3).sort(byName), seq[3]]).toEqual([
      ["question", null, "started"], ["tool", "active_subscriptions", "did"], ["tool", "nope_tool", "refused"], ["answer", null, "did"],
    ]);
    expect(rows[3].p_model).toBe("claude-opus-5-5");
    expect(rows[3].p_tokens_in).toBe(200);
    expect(rows[3].p_tokens_out).toBe(40);
  });

  it("ANTHROPIC_MODEL is used as configured, never a model id of our own", async () => {
    process.env.ANTHROPIC_MODEL = "claude-test-model-9";
    api.script = [final(REPLY)];
    await ask("kitne subscription");
    expect(api.bodies[0].model).toBe("claude-test-model-9");
  });

  it("refusal: a plain message, no internals, no further call", async () => {
    api.script = [msg("refusal", [])];
    const body = await (await ask("kitne subscription")).json();
    expect(body.reply).toMatch(/could not answer/i);
    expect(api.bodies).toHaveLength(1);
    expect(db.rpc.at(-1)?.args.p_kind).toBe("answer");
  });

  it("max_tokens: a plain message", async () => {
    api.script = [msg("max_tokens", [{ type: "text", text: "{\"reply\":\"cut" }])];
    const body = await (await ask("kitne subscription")).json();
    expect(body.reply).toMatch(/too long/i);
  });

  it("max rounds: the model keeps asking → 8 rounds, then the numbers already read, plainly", async () => {
    api.script = Array.from({ length: 12 }, (_, i) => msg("tool_use", [toolUse(`tu_${i}`, "active_subscriptions")]));
    const body = await (await ask("kitne subscription")).json();
    expect(api.bodies).toHaveLength(8);
    expect(body.reply).toContain("Active subscriptions: 2");
    expect(body.ai).toBe(true);
  });

  it("an API error / timeout: a plain answer, status 200, no internals", async () => {
    api.throwNext = new Error("529 overloaded sk-ant-test-not-a-real-key at 10.1.1.1");
    const res = await ask("kitne subscription");
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(200);
    expect(text).toMatch(/cannot answer right now/i);
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("10.1.1.1");
    expect(text).not.toContain("529");
  });

  it("R-2776: an API 400 (bad tool schema) is counted — the help log row says failed + model_error, not ok", async () => {
    api.throwNext = Object.assign(new Error("400 invalid_request_error: tools.0.custom.input_schema is not valid"), { status: 400 });
    const res = await ask("kitne subscription");
    expect(res.status).toBe(200);
    const answer = db.rpc.map((c) => c.args).filter((a) => a.p_kind === "answer");
    expect(answer).toHaveLength(1);
    expect(answer[0].p_outcome).toBe("failed");
    expect(answer[0].p_text).toBe("model_error");
    expect(JSON.stringify(db.rpc)).not.toContain("input_schema"); // the outcome word only — never the API's text
  });

  it("R-2776: a good answer is logged did + answer; a refusal says refusal (and is not 'failed' as a model error is)", async () => {
    api.script = [final(REPLY)];
    await ask("kitne subscription");
    const a1 = db.rpc.map((c) => c.args).filter((a) => a.p_kind === "answer").at(-1);
    expect([a1?.p_outcome, a1?.p_text]).toEqual(["did", "answer"]);
    db.rpc = [];
    api.script = [msg("refusal", [])];
    await ask("kitne subscription");
    const a2 = db.rpc.map((c) => c.args).filter((a) => a.p_kind === "answer").at(-1);
    expect(a2?.p_text).toBe("refusal");
  });

  it("a refused session (service-role key on the client) is a plain answer, status 200 — never a 500, no AI call", async () => {
    db.key = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.y`;
    const res = await ask("kitne subscription");
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toMatch(/cannot answer right now/i);
    expect(api.bodies).toHaveLength(0);
    expect(db.rpc.at(-1)?.args.p_kind).toBe("answer"); // the log still closes
  });

  it("plain text instead of JSON from the model is shown as a plain reply — no actions", async () => {
    api.script = [msg("end_turn", [{ type: "text", text: "Sirf **2** subscription chal rahe hain." }])];
    const body = await (await ask("kitne subscription")).json();
    expect(body.reply).toBe("Sirf 2 subscription chal rahe hain.");
    expect(body.actions).toEqual([]);
  });

  it("a tool the model made up, or with a tenant key: refused and reported back, the loop goes on to the answer", async () => {
    api.script = [msg("tool_use", [toolUse("tu_a", "drop_table"), toolUse("tu_b", "active_subscriptions", { tenant_id: "bbbbbbbb-0000-4000-8000-000000000002" })]), final(REPLY)];
    const body = await (await ask("kitne subscription")).json();
    expect(body.reply).toBe(REPLY.reply);
    const results = (api.bodies[1].messages as { content: { is_error?: boolean; content?: string }[] }[])[2].content;
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0].content).toContain("no such tool");
    expect(results[1].content).toContain("did not match this tool's input schema");
    expect(results[0].content).not.toContain("drop_table");
  });

  it("per-question call cap holds over rounds (20 in all)", async () => {
    const batch = (r: number) => msg("tool_use", Array.from({ length: 8 }, (_, i) => toolUse(`tu_${r}_${i}`, "active_subscriptions")));
    api.script = [batch(1), batch(2), batch(3), batch(4)];
    const body = await (await ask("kitne subscription")).json();
    expect(api.bodies).toHaveLength(3); // 8 + 8 ok; the third turn (24 in all) is refused whole before it is run or counted (R-2776) → stop
    expect(body.reply).toContain("Active subscriptions: 2");
    const calls = db.rpc.map((c) => c.args).filter((r) => r.p_kind === "tool");
    expect(calls.filter((r) => r.p_outcome === "did")).toHaveLength(16);
    expect(calls.filter((r) => r.p_outcome === "refused")).toHaveLength(0); // nothing was spent on the refused turn
    expect(db.rpc.map((c) => c.args).filter((r) => r.p_kind === "answer").at(-1)?.p_text).toBe("calls_cap");
  });
});

describe("everything else keeps the old path", () => {
  const oldPath = async (over: Record<string, unknown> = {}) => {
    gem.answers = [{ tools: ["active_subscriptions"] }, REPLY];
    const body = await (await ask("kitne subscription chal rahe hai", over)).json();
    expect(body.reply).toBe(REPLY.reply);
    expect(api.bodies).toHaveLength(0);
    expect(gem.calls).toBe(2);
  };
  it("flag off", async () => { delete process.env.HELP_AI_V2; await oldPath(); });
  it("flag set to something else", async () => { process.env.HELP_AI_V2 = "off"; await oldPath(); });
  it("another role (manager)", async () => { db.role = "manager"; await oldPath(); });
  it("no Claude key on the server (Gemini only)", async () => { delete process.env.ANTHROPIC_API_KEY; await oldPath(); });
  it("scan mode", async () => { gem.answers = [REPLY]; await ask("", { mode: "scan", messages: [] }); expect(api.bodies).toHaveLength(0); expect(gem.calls).toBe(1); });
  it("a screenshot attached", async () => { await oldPath({ image: { mimeType: "image/png", base64: "aGVsbG8=" } }); });
});

describe("prompt-injection fixture: the model's final answer", () => {
  for (const c of HELP_INJECTION_CASES.filter((x) => x.kind === "final_answer")) {
    it(`${c.id}: no off-site link, no unknown-customer action, no write action reaches the screen`, async () => {
      api.script = [msg("end_turn", [{ type: "text", text: c.payload }])];
      const body = await (await ask("kitne subscription")).json();
      const shown = JSON.stringify(body.actions);
      for (const bad of c.mustNot) expect(shown).not.toContain(bad);
      expect(body.reply).toBeTruthy();
    });
  }
  it("a state change for a customer the facts DO list is kept (it still needs the person's click in the panel)", async () => {
    api.script = [final({ reply: "State missing.", actions: [{ kind: "set_customer_state", label: "Set state", customerId: KNOWN_CUSTOMER, stateCode: "07" }], checklist: [], followUps: [] })];
    const body = await (await ask("customer ka state")).json();
    expect(body.actions).toEqual([{ kind: "set_customer_state", label: "Set state", customerId: KNOWN_CUSTOMER, stateCode: "07" }]);
  });
  it("user_text: asking for another company changes nothing in what the tools read", async () => {
    const c = HELP_INJECTION_CASES.find((x) => x.kind === "user_text")!;
    api.script = [msg("tool_use", [toolUse("tu_a", "active_subscriptions")]), final(REPLY)];
    const body = await (await ask(c.payload.slice(0, 1400))).json();
    expect(body.reply).toBe(REPLY.reply);
    const results = (api.bodies[1].messages as { content: { content?: string }[] }[])[2].content;
    expect(results[0].content).toContain("Active subscriptions: 2"); // this company's 2, not another's
  });
});
