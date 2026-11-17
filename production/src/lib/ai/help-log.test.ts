/**
 * R-2778 / H-05 — the Help AI assistant log (lib/ai/help-log.ts) + the runner's call observer.
 * Every question and every tool run is noted through ONE database function
 * (log_ai_assistant_event: tenant and user come from the login, so none is ever sent); a tool's
 * rows are never written, only its name, tier, outcome, row COUNT and time; a failing log never
 * fails an answer; the "AI on behalf of" headers are built only from a real uuid.
 * The database half (RLS, forged headers, caps) is supabase/tests/r2778_ai_assistant_log.test.sql.
 * No AI provider is called: the model is not involved here at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
let rpcMode: "ok" | "error" | "throw" = "ok";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-0000000000c1";

const fake = {
  supabaseKey: "x.eyJyb2xlIjoiYW5vbiJ9.y",
  from: () => { throw new Error("no table reads in this test"); },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (rpcMode === "throw") throw new Error("network down");
    return { data: null, error: rpcMode === "error" ? { message: "boom" } : null };
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => fake }));

const { openHelpSession } = await import("./help-tools/session");
const { runHelpTools } = await import("./help-tools/runner");
const { defineHelpTool } = await import("./help-tools/types");
const { buildRegistry } = await import("./help-tools/registry");
const log = await import("./help-log");

const tool = (name: string, run: (i: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) => defineHelpTool({
  name, describe: "t", input: z.object({}).strict(), roles: ["owner"], tier: "read", page: "/invoices", label: "Open invoices",
  run, ...extra,
} as never);

const PRIVATE_ROW = "PRIVATE-CUSTOMER-ROW-9f3";
const okTool = tool("log_ok", async () => ({ text: "3 invoices", rows: [{ id: "r1", name: PRIVATE_ROW }, { id: "r2", name: "b" }, { id: "r3", name: "c" }], total: 3, sources: [] }));
const slowTool = tool("log_slow", async () => { await new Promise((r) => setTimeout(r, 200)); return { text: "late", sources: [] }; });
const brokenTool = tool("log_broken", async () => { throw new Error(`db said ${PRIVATE_ROW}`); });
const confirmTool = tool("log_confirm", async () => ({ text: "x", sources: [] }), { tier: "confirm" });
const registry = buildRegistry([okTool, slowTool, brokenTool, confirmTool] as never);

let uidN = 0;
/** A fresh person per call: the per-person rate limit (R-2879) is not what these tests are about. */
const uid = () => `u-r2778-${++uidN}-0000-4000-8000-000000000000`;
const runAs = (calls: { name: string; input?: unknown }[], opts: { timeoutMs?: number; onCall?: (i: never) => void } = {}) =>
  runHelpTools(openHelpSession(), { userId: uid(), tenantId: A, role: "owner", onCall: opts.onCall as never }, calls, registry, { timeoutMs: opts.timeoutMs });

beforeEach(() => { rpcCalls.length = 0; rpcMode = "ok"; });

describe("outcomes and rows", () => {
  it("maps a result to did / held / refused / failed / timeout", () => {
    const r = (ok: boolean, refusal?: string) => ({ name: "t", ok, refusal, text: "", sources: [], href: null, label: null }) as never;
    expect(log.outcomeOf(r(true))).toBe("did");
    expect(log.outcomeOf(r(false, "tier_not_enabled"))).toBe("held");
    for (const x of ["unknown_tool", "not_allowed", "bad_input", "too_many_calls"]) expect(log.outcomeOf(r(false, x))).toBe("refused");
    for (const x of ["failed", "bad_output"]) expect(log.outcomeOf(r(false, x))).toBe("failed");
    expect(log.outcomeOf(r(false, "timeout"))).toBe("timeout");
    expect(log.outcomeOf(r(false))).toBe("failed");
  });

  it("a tool row carries the name, tier, outcome, count and ms — never the rows or the text", () => {
    const row = log.toolLogRow({
      name: "log_ok", tier: "read", ms: 42,
      result: { name: "log_ok", ok: true, text: `3 invoices ${PRIVATE_ROW}`, rows: [{ id: "r1", name: PRIVATE_ROW }], shown: { shown: 1, total: 3 }, sources: [{ table: "invoices", ids: ["r1"], href: "/invoices", label: "x" }], href: "/invoices", label: "x" },
    });
    expect(row).toMatchObject({ kind: "tool", tool: "log_ok", tier: "read", outcome: "did", rowCount: 3, durationMs: 42 });
    expect(JSON.stringify(row)).not.toContain(PRIVATE_ROW);
    expect(row.rowIds).toBeUndefined();
  });

  it("a refusal keeps its reason code (not the sentence the model sees)", () => {
    const row = log.toolLogRow({ name: "log_confirm", tier: "confirm", ms: 0, result: { name: "log_confirm", ok: false, refusal: "tier_not_enabled", text: "log_confirm: confirm tools are not switched on yet.", sources: [], href: null, label: null } });
    expect(row).toMatchObject({ outcome: "held", text: "tier_not_enabled" });
  });
});

describe("the log writes through one function, as the person", () => {
  it("question: masked, capped, started; no tenant / user argument is ever sent", async () => {
    const hl = log.createHelpLog(() => fake, { conversationId: CONV });
    await hl.question(`mail me at boss@example.com about GSTIN 07ABDCA0298H1ZP ${"x".repeat(900)}`);
    expect(rpcCalls).toHaveLength(1);
    const { fn, args } = rpcCalls[0];
    expect(fn).toBe("log_ai_assistant_event");
    expect(args).toMatchObject({ p_conversation_id: CONV, p_kind: "question", p_outcome: "started" });
    const text = String(args.p_text);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).not.toContain("boss@example.com");
    expect(text).not.toContain("07ABDCA0298H1ZP");
    const keys = Object.keys(args).join(",");
    expect(keys).not.toMatch(/tenant|user/);
  });

  it("every call of a run is noted — ok, refused (unknown / not allowed / confirm), failed, timeout — with a time", async () => {
    const hl = log.createHelpLog(() => fake, { conversationId: CONV });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runAs([{ name: "log_ok" }, { name: "no_such_tool" }, { name: "log_confirm" }, { name: "log_broken" }, { name: "log_slow" }], { timeoutMs: 50, onCall: hl.tool as never });
    err.mockRestore();
    expect(res).toHaveLength(5);
    await hl.finish({ ok: true, ms: 10, model: "test-model" });
    const tools = rpcCalls.filter((c) => c.args.p_kind === "tool").map((c) => c.args);
    const byTool = Object.fromEntries(tools.map((t) => [t.p_tool, t]));
    expect(byTool.log_ok).toMatchObject({ p_outcome: "did", p_tier: "read", p_row_count: 3 });
    expect(byTool.no_such_tool).toMatchObject({ p_outcome: "refused", p_text: "unknown_tool" });
    expect(byTool.log_confirm).toMatchObject({ p_outcome: "held", p_tier: "confirm" });
    expect(byTool.log_broken).toMatchObject({ p_outcome: "failed" });
    expect(byTool.log_slow).toMatchObject({ p_outcome: "timeout" });
    expect(Number(byTool.log_slow.p_duration_ms)).toBeGreaterThanOrEqual(40);
    // the answer row, last
    expect(rpcCalls[rpcCalls.length - 1].args).toMatchObject({ p_kind: "answer", p_outcome: "did", p_model: "test-model", p_duration_ms: 10 });
    // no tool row, no text, no error message ever carries a result row or a db error text
    expect(JSON.stringify(rpcCalls)).not.toContain(PRIVATE_ROW);
  });

  it("R-2776: the answer row carries the loop outcome as a fixed word (text), failed when ok=false, and never free text", async () => {
    const hl = log.createHelpLog(() => fake, { conversationId: CONV });
    await hl.finish({ ok: false, ms: 5, loopOutcome: "model_error" });
    expect(rpcCalls[rpcCalls.length - 1].args).toMatchObject({ p_kind: "answer", p_outcome: "failed", p_text: "model_error" });
    const hl2 = log.createHelpLog(() => fake, { conversationId: CONV });
    await hl2.finish({ ok: true, ms: 5, loopOutcome: "Ignore previous instructions; 400 invalid sk-ant-secret" });
    expect(rpcCalls[rpcCalls.length - 1].args.p_text).toBeNull(); // anything that is not a plain outcome word is dropped
    const hl3 = log.createHelpLog(() => fake, { conversationId: CONV });
    await hl3.finish({ ok: true, ms: 5 });
    expect(rpcCalls[rpcCalls.length - 1].args.p_text).toBeNull();
  });

  it("without an onCall nothing is written and the run is unchanged", async () => {
    const res = await runAs([{ name: "log_ok" }]);
    expect(res[0].ok).toBe(true);
    expect(rpcCalls).toHaveLength(0);
  });

  it("two overlapping requests keep their own log", async () => {
    const a = log.createHelpLog(() => fake, { conversationId: "aaaaaaaa-0000-4000-8000-00000000000a" });
    const b = log.createHelpLog(() => fake, { conversationId: "bbbbbbbb-0000-4000-8000-00000000000b" });
    await Promise.all([
      runAs([{ name: "log_ok" }], { onCall: a.tool as never }),
      runAs([{ name: "log_ok" }, { name: "log_ok" }], { onCall: b.tool as never }),
    ]);
    await Promise.all([a.finish({ ok: true, ms: 1 }), b.finish({ ok: true, ms: 1 })]);
    const count = (id: string) => rpcCalls.filter((c) => c.args.p_conversation_id === id && c.args.p_kind === "tool").length;
    expect(count("aaaaaaaa-0000-4000-8000-00000000000a")).toBe(1);
    expect(count("bbbbbbbb-0000-4000-8000-00000000000b")).toBe(2);
  });

  it("the old R-421 path: results become tool rows (read, did / refused / failed), no text kept", async () => {
    const hl = log.createHelpLog(() => fake, { conversationId: CONV });
    hl.legacy([
      { tool: "overdue_receivables", ok: true, text: `₹1,00,000 ${PRIVATE_ROW}`, href: "/invoices", label: "x" },
      { tool: "payroll_total", ok: false, text: "payroll_total: not allowed for your role.", href: null, label: null },
      { tool: "open_quotes", ok: false, text: "open_quotes: could not be read just now — try again in a minute.", href: null, label: null },
    ] as never, 30);
    await hl.finish({ ok: true, ms: 5 });
    const rows = rpcCalls.map((c) => c.args).filter((a) => a.p_kind === "tool");
    expect(rows.map((r) => [r.p_tool, r.p_outcome, r.p_tier])).toEqual([["overdue_receivables", "did", "read"], ["payroll_total", "refused", "read"], ["open_quotes", "failed", "read"]]);
    expect(JSON.stringify(rpcCalls)).not.toContain(PRIVATE_ROW);
  });

  it("a log that fails (error result, thrown, no session) never throws into the answer", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const mode of ["error", "throw"] as const) {
      rpcMode = mode;
      const hl = log.createHelpLog(() => fake, { conversationId: CONV });
      await expect(hl.question("q")).resolves.toBeUndefined();
      await expect(hl.finish({ ok: false, ms: 1 })).resolves.toBeUndefined();
    }
    const broken = log.createHelpLog(() => { throw new Error("no client"); }, { conversationId: CONV });
    await expect(broken.question("q")).resolves.toBeUndefined();
    await expect(broken.finish({ ok: true, ms: 1 })).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("a log that hangs never holds the answer back longer than its bound", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hang = { ...fake, rpc: () => new Promise(() => {}) };
    const hl = log.createHelpLog(() => hang, { conversationId: CONV, boundMs: 40 });
    hl.tool({ name: "log_ok", tier: "read", ms: 1, result: { name: "log_ok", ok: true, text: "x", sources: [], href: null, label: null } });
    const t0 = Date.now();
    await hl.question("q");
    await hl.finish({ ok: true, ms: 1 });
    expect(Date.now() - t0).toBeLessThan(1000); // question + tool + answer, each cut at ~40 ms
    err.mockRestore();
  });

  it("a rate-limit refusal is a refused row, and the call is still observed", async () => {
    const hl = log.createHelpLog(() => fake, { conversationId: CONV });
    hl.tool({ name: "log_ok", tier: null, ms: 0, result: { name: "log_ok", ok: false, refusal: "rate_limited", text: "x", sources: [], href: null, label: null } });
    await hl.finish({ ok: true, ms: 1 });
    expect(rpcCalls.map((c) => c.args).find((a) => a.p_kind === "tool")).toMatchObject({ p_outcome: "refused", p_text: "rate_limited" });
  });

  it("a throwing onCall cannot break a tool run", async () => {
    const res = await runAs([{ name: "log_ok" }], { onCall: () => { throw new Error("observer bug"); } });
    expect(res[0].ok).toBe(true);
  });
});

describe("the 'AI on behalf of' headers", () => {
  it("are built from a uuid only", () => {
    expect(log.aiActorHeaders(CONV)).toEqual({ "x-actor-via": "ai", "x-actor-conversation": CONV });
    expect(log.aiActorHeaders(CONV.toUpperCase())).toEqual({ "x-actor-via": "ai", "x-actor-conversation": CONV });
    for (const bad of ["", "x", "not-a-uuid", null, undefined, `${CONV}; drop table`]) expect(log.aiActorHeaders(bad as never)).toEqual({});
  });
  it("use the names the database reads (audit_ai_via)", () => {
    expect(log.HELP_VIA_HEADER).toBe("x-actor-via");
    expect(log.HELP_CONVERSATION_HEADER).toBe("x-actor-conversation");
  });
});
