/**
 * R-2654 — the month route: owner / accountant only; the browser sends no amounts (extra body fields
 * are ignored, only account + month + line ids reach the server lib); a run or undo refusal reaches the
 * user word for word.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  loadArgs: [] as Array<Record<string, unknown>>,
  runArgs: [] as Array<Record<string, unknown>>,
  undoArgs: [] as string[],
  runOut: { state: "done", result: { runId: "R1", booked: [], refused: [], blocked: 0 } } as unknown,
  undoErr: null as null | { message: string; code: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { tenant_id: "T1", role: state.role }, error: null });
      return q;
    },
  }),
  createAdminClientFor: () => ({}),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/razorpay/settlement-batch.server", () => ({
  loadMonthBatch: async (a: Record<string, unknown>) => { state.loadArgs.push(a); return { state: "batch", batch: { month: a.month, rows: [], ready: 0, blocked: 0, readyAmount: 0 } }; },
  runMonthBatch: async (a: Record<string, unknown>) => { state.runArgs.push(a); return state.runOut; },
  undoMonthRun: async (_db: unknown, runId: string) => {
    state.undoArgs.push(runId);
    if (state.undoErr) throw Object.assign(new Error(state.undoErr.message), { code: state.undoErr.code });
    return { undone: 2, left: [] };
  },
}));

import { GET, POST } from "./route";

const ACC = "11111111-0000-4000-8000-000000000001";
const RUN = "99999999-0000-4000-8000-000000000001";
const post = (body: unknown) => POST(new Request("http://localhost/api/banking/razorpay-settlement/month", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as unknown as NextRequest);
const get = (qs: string) => GET(new Request(`http://localhost/api/banking/razorpay-settlement/month?${qs}`) as unknown as NextRequest);

beforeEach(() => {
  state.role = "owner";
  state.loadArgs = [];
  state.runArgs = [];
  state.undoArgs = [];
  state.undoErr = null;
  state.runOut = { state: "done", result: { runId: "R1", booked: [], refused: [], blocked: 0 } };
});

describe("GET /api/banking/razorpay-settlement/month", () => {
  it("returns the table for the account + month", async () => {
    const res = await get(`accountId=${ACC}&month=2025-10`);
    expect(res.status).toBe(200);
    expect((await res.json()).result.state).toBe("batch");
    expect(state.loadArgs[0]).toMatchObject({ tenantId: "T1", accountId: ACC, month: "2025-10" });
  });
  it("a bad month is refused before anything runs", async () => {
    expect((await get(`accountId=${ACC}&month=2025-13`)).status).toBe(400);
    expect(state.loadArgs).toEqual([]);
  });
  it.each(["billing", "manager", "sales"])("%s is refused (owner / accountant only)", async (role) => {
    state.role = role;
    expect((await get(`accountId=${ACC}&month=2025-10`)).status).toBe(403);
    expect(state.loadArgs).toEqual([]);
  });
  it("accountant may", async () => {
    state.role = "accountant";
    expect((await get(`accountId=${ACC}&month=2025-10`)).status).toBe(200);
  });
});

describe("POST /api/banking/razorpay-settlement/month", () => {
  it("run: only account, month and line ids reach the server — amounts in the body are ignored", async () => {
    const res = await post({ action: "run", accountId: ACC, month: "2025-10", txnIds: [RUN], amount: 99999, rpcArg: { fee_paise: 1 } });
    expect(res.status).toBe(200);
    expect((await res.json()).run.runId).toBe("R1");
    const a = state.runArgs[0];
    expect(a).toMatchObject({ tenantId: "T1", accountId: ACC, month: "2025-10", txnIds: [RUN] });
    expect(a).not.toHaveProperty("amount");
    expect(a).not.toHaveProperty("rpcArg");
  });
  it("run without keys → 409 with the message", async () => {
    state.runOut = { state: "no_keys", message: "Add your Razorpay API key in Settings → Integrations to fetch settlements from Razorpay." };
    const res = await post({ action: "run", accountId: ACC, month: "2025-10" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Add your Razorpay API key/);
  });
  it("undo: passes the run id; a refusal reaches the user word for word", async () => {
    expect((await post({ action: "undo", runId: RUN })).status).toBe(200);
    expect(state.undoArgs).toEqual([RUN]);
    state.undoErr = { message: "This run is not in your company — reload the page and try again.", code: "P0002" };
    const res = await post({ action: "undo", runId: RUN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This run is not in your company — reload the page and try again.");
  });
  it("billing cannot run or undo", async () => {
    state.role = "billing";
    expect((await post({ action: "run", accountId: ACC, month: "2025-10" })).status).toBe(403);
    expect((await post({ action: "undo", runId: RUN })).status).toBe(403);
    expect(state.runArgs).toEqual([]);
    expect(state.undoArgs).toEqual([]);
  });
});
