/**
 * R-2099 — the Razorpay settlement route: role-gated; Reconcile rebuilds the plan on the server
 * and sends ITS numbers to reconcile_razorpay_settlement (never the browser's); a blocked plan
 * or missing keys write nothing; the function's own refusal reaches the user word for word.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  result: null as unknown,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcError: null as null | { message: string; code: string },
  loadArgs: [] as unknown[],
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcError ? { data: null, error: state.rpcError } : { data: { kind: "razorpay_settlement", payments: 3, fee: 189 }, error: null };
    },
  }),
  createAdminClientFor: () => ({}),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/razorpay/settlement.server", () => ({
  loadSettlementPlan: async (a: unknown) => { state.loadArgs.push(a); return state.result; },
}));

import { GET, POST } from "./route";

const TXN = "11111111-0000-4000-8000-000000000001";
const RPC_ARG = { id: "setl_A", utr: "U", fee_paise: 18900, tax_paise: 2900, payments: [{ rzp_id: "pay_1", amount_paise: 118000, payment_ids: ["a1"] }], refunds: [] };
const readyPlan = { state: "plan", plan: { ready: true, blockers: [], rpcArg: RPC_ARG } };
const post = (body: unknown) => POST(new Request("http://localhost/api/banking/razorpay-settlement", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as unknown as NextRequest);

beforeEach(() => {
  state.role = "owner";
  state.result = readyPlan;
  state.rpcCalls = [];
  state.rpcError = null;
  state.loadArgs = [];
});

describe("GET /api/banking/razorpay-settlement", () => {
  it("returns the plan; nothing written", async () => {
    const res = await GET(new Request(`http://localhost/api/banking/razorpay-settlement?txnId=${TXN}`) as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual(readyPlan);
    expect(state.rpcCalls).toEqual([]);
  });

  it.each(["sales", "support"])("%s → 403", async (role) => {
    state.role = role;
    const res = await GET(new Request(`http://localhost/api/banking/razorpay-settlement?txnId=${TXN}`) as unknown as NextRequest);
    expect(res.status).toBe(403);
    expect(state.loadArgs).toEqual([]);
  });
});

describe("POST /api/banking/razorpay-settlement", () => {
  it("ready → ONE call with the server's own plan; browser numbers are not accepted", async () => {
    const res = await post({ txnId: TXN, picks: {}, fee: 1, payments: [{ amount: 1 }] });
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toEqual([{ fn: "reconcile_razorpay_settlement", args: { p_txn_id: TXN, p_settlement: RPC_ARG } }]);
  });

  it("picks are passed to the plan (validated ids only)", async () => {
    await post({ txnId: TXN, picks: { pay_2: "22222222-0000-4000-8000-000000000002" } });
    expect(state.loadArgs[0]).toMatchObject({ picks: { pay_2: "22222222-0000-4000-8000-000000000002" } });
    const bad = await post({ txnId: TXN, picks: { "x; drop": "nope" } });
    expect(bad.status).toBe(400);
  });

  it("blocked plan → 409 with the first reason; nothing written", async () => {
    state.result = { state: "plan", plan: { ready: false, blockers: ["Razorpay payment pay_2 (₹2,360) is not in the app."], rpcArg: null } };
    const res = await post({ txnId: TXN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/pay_2/);
    expect(state.rpcCalls).toEqual([]);
  });

  it("no keys → 409 with the Settings message", async () => {
    state.result = { state: "no_keys", message: "Add your Razorpay API key in Settings → Integrations to fetch settlements from Razorpay." };
    const res = await post({ txnId: TXN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Settings → Integrations/);
    expect(state.rpcCalls).toEqual([]);
  });

  it("the function's refusal (e.g. second click) reaches the user word for word", async () => {
    state.rpcError = { code: "23514", message: "This bank line is already reconciled (payment). Un-reconcile it first if it was matched wrongly." };
    const res = await post({ txnId: TXN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already reconciled/);
  });
});
