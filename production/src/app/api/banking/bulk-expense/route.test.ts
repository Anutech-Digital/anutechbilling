/**
 * R-2611 — bulk book money-out lines as expenses: each row goes through the existing
 * book_bank_txn_as_expense; one refused row never stops the others; repeated ids are booked once;
 * challan / Salaries / reconciled / money-in lines never reach the function.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const ID = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;

const state = vi.hoisted(() => ({
  role: "owner" as string,
  lines: [] as Array<{ id: string; description: string | null; debit: number; matched_to_type: string | null }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcErrors: {} as Record<string, { message: string; code: string }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { tenant_id: "T1", role: state.role }, error: null });
      q.in = async (_c: string, ids: string[]) => ({ data: table === "bank_transactions" ? state.lines.filter((l) => ids.includes(l.id)) : [], error: null });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      const e = state.rpcErrors[String(args.p_txn_id)];
      return e ? { data: null, error: e } : { data: `EXP-${String(args.p_txn_id).slice(-2)}`, error: null };
    },
  }),
  createAdminClientFor: () => ({}),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/banking/bulk-expense", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as unknown as NextRequest);

beforeEach(() => {
  state.role = "owner";
  state.rpcCalls = [];
  state.rpcErrors = {};
  state.lines = [
    { id: ID(1), description: "POS FACEBK ADS", debit: 2000, matched_to_type: null },
    { id: ID(2), description: "UPI-SHARMA ASSOC", debit: 11800, matched_to_type: null },
    { id: ID(3), description: "NEFT AWS", debit: 500, matched_to_type: null },
    { id: ID(4), description: "ITNS 281 TDS", debit: 900, matched_to_type: null },
    { id: ID(5), description: "NEFT X", debit: 900, matched_to_type: "expense" },
    { id: ID(6), description: "NEFT IN", debit: 0, matched_to_type: null },
  ];
});

describe("POST /api/banking/bulk-expense", () => {
  it("books every row through book_bank_txn_as_expense; a guard refusal is reported, the rest still booked", async () => {
    state.rpcErrors[ID(2)] = { code: "P0001", message: "Sharma Associates has an open bill PS-2 for ₹11,800. Pay it with \"Record payment\" on this line instead of booking a new expense, or the cost is counted twice." };
    const res = await post({ rows: [
      { txnId: ID(1), category: "Advertising", payee: "Facebook" },
      { txnId: ID(2), category: "Professional Services", payee: "Sharma Associates" },
      { txnId: ID(3), category: "Hosting" },
    ] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booked).toBe(2);
    expect(body.refused).toBe(1);
    expect(body.results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/Record payment/) });
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(Array(3).fill("book_bank_txn_as_expense"));
    expect(state.rpcCalls[0].args).toEqual({ p_txn_id: ID(1), p_category: "Advertising", p_vendor: "Facebook", p_gst: 0, p_notes: "POS FACEBK ADS" });
    expect(state.rpcCalls[2].args.p_vendor).toBeNull();
  });

  it("an unexpected DB error is a plain sentence, not the raw error", async () => {
    state.rpcErrors[ID(1)] = { code: "XX000", message: "internal boom" };
    const body = await (await post({ rows: [{ txnId: ID(1), category: "Advertising" }] })).json();
    expect(body.results[0].error).toMatch(/Reconcile sheet/);
    expect(body.results[0].error).not.toMatch(/boom/);
  });

  it("challan, reconciled, money-in, Salaries and unknown lines never reach the function", async () => {
    const body = await (await post({ rows: [
      { txnId: ID(4), category: "Bank Charges" },
      { txnId: ID(5), category: "Bank Charges" },
      { txnId: ID(6), category: "Bank Charges" },
      { txnId: ID(3), category: "Salaries" },
      { txnId: ID(9), category: "Bank Charges" },
    ] })).json();
    expect(body.booked).toBe(0);
    expect(body.results.map((r: { error: string }) => r.error)).toEqual([
      expect.stringMatching(/TDS challan/), expect.stringMatching(/already reconciled/),
      expect.stringMatching(/money-out/), expect.stringMatching(/Payroll/), expect.stringMatching(/not found/),
    ]);
    expect(state.rpcCalls).toEqual([]);
  });

  it("Postgres's own permission error (42501) is never shown raw", async () => {
    state.rpcErrors[ID(1)] = { code: "42501", message: "permission denied for table expenses" };
    const body = await (await post({ rows: [{ txnId: ID(1), category: "Advertising" }] })).json();
    expect(body.results[0].error).toMatch(/^Only Owner, Manager, Accountant or Billing/);
  });

  it("results keep the ticked order while rows are booked a few at a time", async () => {
    const body = await (await post({ rows: [3, 1, 2].map((n) => ({ txnId: ID(n), category: "Hosting" })) })).json();
    expect(body.results.map((r: { txnId: string }) => r.txnId)).toEqual([ID(3), ID(1), ID(2)]);
    expect(body.booked).toBe(3);
  });

  it("a repeated id is booked once", async () => {
    const body = await (await post({ rows: [{ txnId: ID(1), category: "Advertising" }, { txnId: ID(1), category: "Advertising" }] })).json();
    expect(body.results).toHaveLength(1);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("more than 100 rows is refused, nothing booked", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ txnId: ID(100 + i), category: "Hosting" }));
    const res = await post({ rows });
    expect(res.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it("a role that may not reconcile is refused", async () => {
    state.role = "sales";
    const res = await post({ rows: [{ txnId: ID(1), category: "Advertising" }] });
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });
});
