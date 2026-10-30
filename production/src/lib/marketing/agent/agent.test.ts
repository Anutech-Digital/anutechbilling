/**
 * R-2157 (G-ADS-AI, AI-01) — CampaignState schema, the tenant checkpointer and the
 * foundation graph (start → waits at the human gate → resume → done), on an in-memory store
 * with the same write rules as agent_checkpoints.
 */
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { AgentThreadError, TenantCheckpointSaver, memoryCheckpointStore } from "./checkpointer";
import { compileCampaignGraph } from "./graph";
import { AgentConflictError, readRun, resumeRun, startRun } from "./runner";
import { BriefSchema, CampaignStateSchema, PendingActionSchema, initialState } from "./state";

const TENANT = "dddddddd-0000-4000-8000-000000215701";
const PLAN = "eeeeeeee-0000-4000-8000-000000215701";
const seed = { tenantId: TENANT, planId: PLAN, campaignId: null, prompt: "Launch a campaign to increase sales of Google Workspace in Delhi, ₹500/day" };

const brief = {
  goal: "sales", targetRoas: 3, audience: { geo: ["Delhi"], ageMin: 25, ageMax: 55, interests: ["Small business"] },
  budget: { daily: 500, total: null, currency: "INR" }, platforms: ["google", "meta"], itemIds: ["gws"],
  landingUrl: "https://anutech.in/google-workspace", utmCode: "gws-delhi",
};

describe("CampaignState schema", () => {
  it("seeds a thread from the plan: thread = plan, intent from the prompt, Draft, nothing else", () => {
    const s = initialState(seed);
    expect(s).toMatchObject({ tenantId: TENANT, planId: PLAN, threadId: PLAN, userIntent: seed.prompt, brief: null, iteration: 0 });
    expect(s.deployment).toEqual({ status: "Draft", platformIds: {} });
    expect(initialState(seed, "  Only Meta please ").userIntent).toBe("Only Meta please");
  });

  it("accepts the owner's example brief and refuses bad ones", () => {
    expect(BriefSchema.parse(brief).budget.daily).toBe(500);
    expect(BriefSchema.safeParse({ ...brief, platforms: [] }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief, platforms: ["tiktok"] }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief, budget: { ...brief.budget, currency: "USD" } }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief, budget: { ...brief.budget, daily: -1 } }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief, landingUrl: "http://anutech.in" }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...brief, audience: { ...brief.audience, ageMin: 50, ageMax: 20 } }).success).toBe(false);
  });

  it("creatives are 1:1 or 9:16 only", () => {
    const s = initialState(seed);
    const creative = { id: "c1", storagePath: null, aspectRatio: "1:1", headline: "h", description: "d", cta: "Buy", channel: "meta", status: "draft", checks: [] };
    expect(CampaignStateSchema.safeParse({ ...s, creatives: [creative] }).success).toBe(true);
    expect(CampaignStateSchema.safeParse({ ...s, creatives: [{ ...creative, aspectRatio: "4:5" }] }).success).toBe(false);
  });

  it("raising spend, publishing or a new creative can never skip approval", () => {
    const a = { id: "a1", type: "budget_up", moneyDelta: 200, reason: "ROAS 4x", needsApproval: false, approvalId: null };
    expect(PendingActionSchema.safeParse(a).success).toBe(false);
    expect(PendingActionSchema.safeParse({ ...a, type: "publish", moneyDelta: 0 }).success).toBe(false);
    expect(PendingActionSchema.safeParse({ ...a, needsApproval: true }).success).toBe(true);
    expect(PendingActionSchema.safeParse({ ...a, type: "budget_down", moneyDelta: -100 }).success).toBe(true);
  });

  it("a thread that is not its plan is refused", () => {
    expect(CampaignStateSchema.safeParse({ ...initialState(seed), threadId: TENANT }).success).toBe(false);
  });
});

describe("TenantCheckpointSaver", () => {
  const cfg = (extra: Record<string, unknown> = {}) => ({ configurable: { thread_id: PLAN, checkpoint_ns: "", ...extra } });

  it("round-trips a checkpoint, its parent and its pending writes", async () => {
    const store = memoryCheckpointStore();
    const saver = new TenantCheckpointSaver(store);
    const c1 = { ...emptyCheckpoint(), id: uuid6(-1) };
    const r1 = await saver.put(cfg(), c1, { source: "input", step: -1, parents: {} }, {});
    const c2 = { ...emptyCheckpoint(), id: uuid6(-1), channel_values: { userIntent: "hi" } };
    const r2 = await saver.put(r1, c2, { source: "loop", step: 0, parents: {} }, {});
    await saver.putWrites(r2, [["brief", { goal: "sales" }]], "task-1");

    const latest = await saver.getTuple(cfg());
    expect(latest?.checkpoint.id).toBe(c2.id);
    expect(latest?.checkpoint.channel_values).toEqual({ userIntent: "hi" });
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe(c1.id);
    expect(latest?.pendingWrites).toEqual([["task-1", "brief", { goal: "sales" }]]);
    expect((await saver.getTuple(cfg({ checkpoint_id: c1.id })))?.checkpoint.id).toBe(c1.id);

    const all: string[] = [];
    for await (const t of saver.list(cfg())) all.push(t.checkpoint.id);
    expect(all).toEqual([c2.id, c1.id]);
    const loops: string[] = [];
    for await (const t of saver.list(cfg(), { filter: { source: "loop" } })) loops.push(t.checkpoint.id);
    expect(loops).toEqual([c2.id]);
    const older: string[] = [];
    for await (const t of saver.list(cfg(), { before: { configurable: { checkpoint_id: c2.id } } })) older.push(t.checkpoint.id);
    expect(older).toEqual([c1.id]);
  });

  it("a retried regular write keeps the first value; a special write is replaced", async () => {
    const store = memoryCheckpointStore();
    const saver = new TenantCheckpointSaver(store);
    const r = await saver.put(cfg(), { ...emptyCheckpoint(), id: uuid6(-1) }, { source: "input", step: -1, parents: {} }, {});
    await saver.putWrites(r, [["brief", "first"]], "t");
    await saver.putWrites(r, [["brief", "second"]], "t");
    await saver.putWrites(r, [["__error__", "e1"]], "t");
    await saver.putWrites(r, [["__error__", "e2"]], "t");
    const w = (await saver.getTuple(cfg()))?.pendingWrites ?? [];
    expect(w.filter(([, ch]) => ch === "brief").map(([, , v]) => v)).toEqual(["first"]);
    expect(w.filter(([, ch]) => ch === "__error__").map(([, , v]) => v)).toEqual(["e2"]);
  });

  it("only a plan id (uuid) is a thread — nothing else reaches the store", async () => {
    const saver = new TenantCheckpointSaver(memoryCheckpointStore());
    await expect(saver.getTuple({ configurable: { thread_id: "__proto__" } })).rejects.toBeInstanceOf(AgentThreadError);
    await expect(saver.getTuple({ configurable: {} })).rejects.toBeInstanceOf(AgentThreadError);
    await expect(saver.put({ configurable: { thread_id: "x' or 1=1 --" } }, emptyCheckpoint(), { source: "input", step: -1, parents: {} }, {}))
      .rejects.toBeInstanceOf(AgentThreadError);
    await expect(saver.deleteThread("not-a-uuid")).rejects.toBeInstanceOf(AgentThreadError);
  });

  it("deleteThread removes the thread's checkpoints and writes", async () => {
    const store = memoryCheckpointStore();
    const saver = new TenantCheckpointSaver(store);
    const r = await saver.put(cfg(), { ...emptyCheckpoint(), id: uuid6(-1) }, { source: "input", step: -1, parents: {} }, {});
    await saver.putWrites(r, [["brief", 1]], "t");
    await saver.deleteThread(PLAN);
    expect(store.rows).toEqual([]);
    expect(store.writes).toEqual([]);
  });
});

describe("foundation graph: start → waits at the gate → resume → done", () => {
  it("stops at the human gate with the question, survives a new graph instance, then finishes on approve", async () => {
    const store = memoryCheckpointStore();
    const graph = compileCampaignGraph(new TenantCheckpointSaver(store));
    expect((await readRun(graph, PLAN)).status).toBe("not_started");

    const started = await startRun(graph, initialState(seed));
    expect(started.status).toBe("waiting");
    expect(started.next).toEqual(["humanGate"]);
    expect(started.waitingFor).toEqual([expect.objectContaining({ kind: "review", planId: PLAN, options: ["approve", "edit", "reject"] })]);
    expect(started.state).toMatchObject({ planId: PLAN, iteration: 1, deployment: { status: "Draft" }, lastDecision: null });
    expect(store.rows.length).toBeGreaterThan(0);

    // Another server instance (new graph, same rows) carries on from the checkpoint.
    const later = compileCampaignGraph(new TenantCheckpointSaver(store));
    const done = await resumeRun(later, PLAN, { decision: "approve", note: "Looks good" });
    expect(done.status).toBe("done");
    expect(done.waitingFor).toEqual([]);
    expect(done.state?.lastDecision).toMatchObject({ decision: "approve", note: "Looks good" });
    expect(done.state?.iteration).toBe(1);
  });

  it("start twice is refused (a thread runs once); resume when not waiting is refused", async () => {
    const graph = compileCampaignGraph(new TenantCheckpointSaver(memoryCheckpointStore()));
    await expect(resumeRun(graph, PLAN, { decision: "approve" })).rejects.toBeInstanceOf(AgentConflictError);
    await startRun(graph, initialState(seed));
    await expect(startRun(graph, initialState(seed))).rejects.toBeInstanceOf(AgentConflictError);
    await resumeRun(graph, PLAN, { decision: "reject" });
    await expect(resumeRun(graph, PLAN, { decision: "approve" })).rejects.toBeInstanceOf(AgentConflictError);
  });

  it("one company's store never shows another company's thread", async () => {
    const a = compileCampaignGraph(new TenantCheckpointSaver(memoryCheckpointStore()));
    const b = compileCampaignGraph(new TenantCheckpointSaver(memoryCheckpointStore()));
    await startRun(a, initialState(seed));
    expect((await readRun(b, PLAN)).status).toBe("not_started");
  });
});
