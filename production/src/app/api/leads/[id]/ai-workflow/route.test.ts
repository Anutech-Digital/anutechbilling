/**
 * R-2039 — who may press "Run AI Lead Workflow". Signed out → 401; a role that cannot open Leads
 * → 403; a lead the caller's own client cannot see (another company's, or hidden by the
 * hierarchy) → 404 — in all three the runner (AI, website reads, writes) is never called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const s = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  role: "sales" as string,
  tenant: "11111111-1111-4111-8111-111111111111" as string | null,
  visible: true,
  run: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) q[m] = () => q;
    q.maybeSingle = async () => {
      if (table === "users") return { data: s.tenant ? { tenant_id: s.tenant, role: s.role } : null, error: null };
      if (table === "leads") return { data: s.visible ? { id: "L1" } : null, error: null };
      return { data: null, error: null };
    };
    return q;
  };
  return {
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: s.user } }) }, from: chain }),
    createAdminClient: () => ({ admin: true }),
  };
});
vi.mock("@/lib/leads/ai-workflow.server", () => ({ runLeadAiWorkflow: s.run, latestLeadAiRun: s.latest }));

import { POST, GET } from "./route";

const params = { params: Promise.resolve({ id: "L1" }) };
const post = () => POST(new Request("http://x/api/leads/L1/ai-workflow", { method: "POST" }), params);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(s, { user: { id: "u1" }, role: "sales", tenant: "11111111-1111-4111-8111-111111111111", visible: true });
  s.run.mockResolvedValue({ kind: "done", status: 200, run: { id: "r1", step: "draft_ready" } });
});

describe("R-2039 POST /api/leads/[id]/ai-workflow", () => {
  it("signed out → 401, runner not called", async () => {
    s.user = null;
    expect((await post()).status).toBe(401);
    expect(s.run).not.toHaveBeenCalled();
  });

  it("a role that cannot open Leads → 403, runner not called", async () => {
    s.role = "not-a-role";
    const res = await post();
    expect(res.status).toBe(403);
    expect(s.run).not.toHaveBeenCalled();
  });

  it("another company's lead (not visible to the caller's client) → 404 with a next step, runner not called", async () => {
    s.visible = false;
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Lead not found.", detail: expect.stringContaining("refresh") });
    expect(s.run).not.toHaveBeenCalled();
  });

  it("allowed → runs with the tenant from the caller's users row (never from the request)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(s.run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "11111111-1111-4111-8111-111111111111", leadId: "L1", userId: "u1" }));
    expect(await res.json()).toMatchObject({ run: { id: "r1" }, alreadyRunning: false });
  });

  it("second press while running → 202 with the running run", async () => {
    s.run.mockResolvedValue({ kind: "running", status: 202, run: { id: "r1", step: "fetching" } });
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ alreadyRunning: true });
  });

  it("errors carry what went wrong + the next step (§24)", async () => {
    s.run.mockResolvedValue({ kind: "error", status: 429, error: "Your company has used this month's AI limit.", detail: "Wait for the limit to reset." });
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Your company has used this month's AI limit.", detail: "Wait for the limit to reset." });
  });

  it("GET returns the latest run through the caller's client; hidden lead → 404", async () => {
    s.latest.mockResolvedValue({ id: "r1", step: "qualified" });
    expect(await (await GET(new Request("http://x"), params)).json()).toEqual({ run: { id: "r1", step: "qualified" } });
    s.visible = false;
    expect((await GET(new Request("http://x"), params)).status).toBe(404);
  });
});
