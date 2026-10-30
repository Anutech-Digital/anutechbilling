/**
 * R-2157 (G-ADS-AI, AI-01) — POST /api/marketing/agent/start, POST /resume, GET /state.
 * The DB is a fake behind withTenant; the checkpointer runs on an in-memory store per company
 * (the real one is agent_checkpoints under RLS — supabase/tests/r2157_agent_checkpoints.test.sql).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryCheckpointStore, type CheckpointStore } from "@/lib/marketing/agent/checkpointer";

const PLAN = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";
const OTHER_PLAN = "7a2d3b63-7c9f-4c8b-8b6a-1a6f9a4a1b22";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

type Plan = { id: string; tenant_id: string; marketing_campaign_id: string | null; prompt: string };
const h = vi.hoisted(() => ({
  session: null as { userId: string; tenantId: string; aal: string } | null,
  role: "owner" as string | null,
  active: true,
  plans: [] as Array<{ id: string; tenant_id: string; marketing_campaign_id: string | null; prompt: string }>,
  stores: new Map<string, unknown>(),
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: h.active } : null) },
    ad_plans: {
      findFirst: async ({ where }: { where: { id: string; tenant_id: string } }) =>
        h.plans.find((p: Plan) => p.id === where.id && p.tenant_id === where.tenant_id) ?? null,
    },
  }),
}));
vi.mock("@/lib/marketing/agent/prisma-store", () => ({
  prismaCheckpointStore: (s: { tenantId: string }) => {
    if (!h.stores.has(s.tenantId)) h.stores.set(s.tenantId, memoryCheckpointStore());
    return h.stores.get(s.tenantId) as CheckpointStore;
  },
}));

import { POST as START } from "./start/route";
import { POST as RESUME } from "./resume/route";
import { GET as STATE } from "./state/route";

const post = (fn: (r: Request) => Promise<Response>, body: unknown) => fn(new Request("https://example.invalid/api/marketing/agent", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const start = (body: unknown) => post(START, body);
const resume = (body: unknown) => post(RESUME, body);
const state = (planId: string) => STATE(new Request(`https://example.invalid/api/marketing/agent/state?planId=${planId}`));

beforeEach(() => {
  h.session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", tenantId: T1, aal: "aal1" };
  h.role = "marketing";
  h.active = true;
  h.stores = new Map();
  h.plans = [
    { id: PLAN, tenant_id: T1, marketing_campaign_id: null, prompt: "Launch a campaign to increase sales of Google Workspace in Delhi, ₹500/day" },
    { id: OTHER_PLAN, tenant_id: T2, marketing_campaign_id: null, prompt: "Other company's plan" },
  ];
});

describe("owner's path: start → waits at review → approve → done", () => {
  it("marketing starts the agent on a saved plan, sees it waiting, approves, sees it done", async () => {
    const s = await start({ planId: PLAN });
    expect(s.status).toBe(200);
    const { run } = await s.json();
    expect(run).toMatchObject({ planId: PLAN, status: "waiting", next: ["humanGate"] });
    expect(run.waitingFor[0]).toMatchObject({ kind: "review", options: ["approve", "edit", "reject"] });
    expect(run.state).toMatchObject({ tenantId: T1, planId: PLAN, threadId: PLAN, userIntent: h.plans[0].prompt, iteration: 1 });

    const st = await (await state(PLAN)).json();
    expect(st.run.status).toBe("waiting");

    const r = await resume({ planId: PLAN, decision: "approve" });
    expect(r.status).toBe(200);
    const done = (await r.json()).run;
    expect(done.status).toBe("done");
    expect(done.state.lastDecision).toMatchObject({ decision: "approve" });
  });

  it("the owner may run it too; the typed intent beats the plan's prompt", async () => {
    h.role = "owner";
    const { run } = await (await start({ planId: PLAN, intent: "Only Meta, ₹300/day" })).json();
    expect(run.state.userIntent).toBe("Only Meta, ₹300/day");
  });

  it("state before start says not_started", async () => {
    const { run } = await (await state(PLAN)).json();
    expect(run).toMatchObject({ status: "not_started", state: null });
  });
});

describe("guards", () => {
  it("401 with no session — on all three", async () => {
    h.session = null;
    expect((await start({ planId: PLAN })).status).toBe(401);
    expect((await resume({ planId: PLAN, decision: "approve" })).status).toBe(401);
    expect((await state(PLAN)).status).toBe(401);
  });

  it("403 for manager, sales, billing, a deactivated owner and a missing users row", async () => {
    for (const role of ["manager", "sales", "billing"]) {
      h.role = role;
      expect((await start({ planId: PLAN })).status).toBe(403);
      expect((await resume({ planId: PLAN, decision: "approve" })).status).toBe(403);
      expect((await state(PLAN)).status).toBe(403);
    }
    h.role = "owner"; h.active = false;
    expect((await start({ planId: PLAN })).status).toBe(403);
    h.role = null;
    expect((await state(PLAN)).status).toBe(403);
  });

  it("404 for another company's plan — and nothing is written for it", async () => {
    expect((await start({ planId: OTHER_PLAN })).status).toBe(404);
    expect((await resume({ planId: OTHER_PLAN, decision: "approve" })).status).toBe(404);
    expect((await state(OTHER_PLAN)).status).toBe(404);
    const mine = h.stores.get(T1) as ReturnType<typeof memoryCheckpointStore> | undefined;
    expect(mine?.rows ?? []).toEqual([]);
  });

  it("400 for a bad body", async () => {
    expect((await start({})).status).toBe(400);
    expect((await start({ planId: "not-a-uuid" })).status).toBe(400);
    expect((await start({ planId: PLAN, intent: "x".repeat(4001) })).status).toBe(400);
    expect((await resume({ planId: PLAN, decision: "spend-more" })).status).toBe(400);
    expect((await resume({ planId: PLAN, decision: "approve", note: "x".repeat(1001) })).status).toBe(400);
    expect((await state("__proto__")).status).toBe(400);
  });

  it("400 when there is nothing to work from (blank prompt and no intent)", async () => {
    h.plans[0].prompt = "   ";
    expect((await start({ planId: PLAN, intent: "  " })).status).toBe(400);
  });

  it("409: start twice; resume before start; resume after done", async () => {
    expect((await resume({ planId: PLAN, decision: "approve" })).status).toBe(409);
    expect((await start({ planId: PLAN })).status).toBe(200);
    const again = await start({ planId: PLAN });
    expect(again.status).toBe(409);
    expect((await again.json()).run.status).toBe("waiting");
    expect((await resume({ planId: PLAN, decision: "reject", note: "Wrong city" })).status).toBe(200);
    expect((await resume({ planId: PLAN, decision: "approve" })).status).toBe(409);
  });
});
