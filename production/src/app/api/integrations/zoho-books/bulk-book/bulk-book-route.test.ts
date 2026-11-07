/**
 * R-2535 — POST /api/integrations/zoho-books/bulk-book: "Reconcile from Zoho" booked on the server.
 * Owner / accountant only; the DATABASE screens every line first (another company's id, a line
 * already reconciled, a locked month → refused, nothing booked); the row's amount must be the line's;
 * a run twice books nothing twice; each booked line is recorded on the run (for Undo).
 * The Supabase session is a fake that behaves like the RPCs; values are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PlanRow } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";

const ACCOUNT = "55555555-0000-4000-8000-000000000001";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const LOCKED = "aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_CO = "bbbbbbbb-0000-4000-8000-000000000009";
const CUST = "cccccccc-0000-4000-8000-000000000001";
const RUN = "dddddddd-0000-4000-8000-000000000001";

type Line = { credit: number; txn_date: string; matched: string | null; locked?: boolean };
const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  lines: {} as Record<string, { credit: number; txn_date: string; matched: string | null; locked?: boolean }>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: "t1", role: st.role, canManage: true, admin: {} }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcs.push([fn, args]);
      if (fn === "bank_recon_run_screen") {
        /* bank_recon_run_screen: own account's lines only; another company's id = not_found. */
        return {
          data: (args.p_txn_ids as string[]).map((id) => {
            const l = st.lines[id];
            if (!l) return { txn_id: id, ok: false, reason: "not_found", credit: null, txn_date: null };
            const reason = l.matched ? "matched" : l.locked ? "locked" : null;
            return { txn_id: id, ok: reason === null, reason, credit: l.credit, txn_date: l.txn_date };
          }),
          error: null,
        };
      }
      if (fn === "bank_recon_run_start") return { data: RUN, error: null };
      if (fn === "bank_recon_run_record") return { data: true, error: null };
      if (fn === "reconcile_bank_credit_new_sale") {
        const l = st.lines[args.p_txn_id as string];
        if (!l || l.matched) return { data: null, error: { message: "This bank line is already reconciled" } };
        l.matched = "payment";
        return { data: { quote_id: `Q-${String(args.p_txn_id).slice(-1)}`, invoice_issued: `INV-${String(args.p_txn_id).slice(-1)}`, subscriptions: [] }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, v: string) => ({
          maybeSingle: async () => ({ data: table === "bank_transactions" && st.lines[v] ? { matched_to_type: st.lines[v].matched } : null, error: null }),
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

function row(txnId: string, credit: number, txnDate = "2025-10-10", customer: PlanRow["customer"] = { kind: "existing", id: CUST, name: "Buyer", by: "gstin" }): PlanRow {
  return {
    txnId, txnDate, credit, description: "NEFT CR-X", kind: "match", summary: null,
    zoho: { paymentId: "z1", paymentNumber: "P-1", by: "utr", amount: credit, invoiceNumbers: ["INV-001"], candidates: 1 },
    customer, lines: [], seatDiffs: [], saleTotal: credit, tds: 0, payer: null, problems: [], notes: [], ticked: true,
    book: {
      kind: "new_sale", item: null, opening: null, lines: [{ itemId: null, name: "Workspace", qty: 1, unitPrice: credit, gstRate: 0 }],
      createSubscription: false, subStart: null, subRenewal: null, tdsAmount: 0, tdsRatePct: null, tdsSection: null,
      billingCycle: null, externalNumber: null, dateFixes: [], fx: null,
    },
  } as unknown as PlanRow;
}

const call = (body: unknown) => POST(new NextRequest("http://localhost:3001/api/integrations/zoho-books/bulk-book", {
  method: "POST", headers: { "content-type": "application/json", cookie: "sb=1" }, body: JSON.stringify(body),
}));
const booked = () => st.rpcs.filter(([fn]) => fn === "reconcile_bank_credit_new_sale").length;

beforeEach(() => {
  st.role = "owner";
  st.rpcs = [];
  const lines: Record<string, Line> = {
    [L1]: { credit: 11800, txn_date: "2025-10-10", matched: null },
    [L2]: { credit: 5900, txn_date: "2025-10-10", matched: "payment" },
    [LOCKED]: { credit: 2360, txn_date: "2025-04-10", matched: null, locked: true },
  };
  st.lines = lines;
});

describe("R-2535 bulk-book route", () => {
  it("a billing user is refused before anything is read or booked", async () => {
    st.role = "billing";
    const res = await call({ accountId: ACCOUNT, rows: [row(L1, 11800)] });
    expect(res.status).toBe(403);
    expect(st.rpcs).toEqual([]);
  });

  it("books a clean row through the sheet's RPC, records it on the run, returns the run id", async () => {
    const res = await call({ accountId: ACCOUNT, rows: [row(L1, 11800)] });
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.runId).toBe(RUN);
    expect(j.done.map((d: { txnId: string; outcome: string }) => [d.txnId, d.outcome])).toEqual([[L1, "booked"]]);
    const rec = st.rpcs.find(([fn]) => fn === "bank_recon_run_record");
    expect(rec?.[1]).toEqual({ p_run_id: RUN, p_txn_id: L1, p_kind: "new_sale" });
    const sale = st.rpcs.find(([fn]) => fn === "reconcile_bank_credit_new_sale");
    expect(sale?.[1].p_customer_id).toBe(CUST);
  });

  it("double run: the same row again is refused as already reconciled — booked once", async () => {
    await call({ accountId: ACCOUNT, rows: [row(L1, 11800)] });
    const j = await (await call({ accountId: ACCOUNT, runId: RUN, rows: [row(L1, 11800)] })).json();
    expect(booked()).toBe(1);
    expect(j.done).toEqual([]);
    expect(j.refused[0].reason).toMatch(/Already reconciled/);
  });

  it("a line already matched, a locked month and another company's id are refused; only the free line is booked", async () => {
    const j = await (await call({ accountId: ACCOUNT, rows: [row(L2, 5900), row(LOCKED, 2360, "2025-04-10"), row(OTHER_CO, 100), row(L1, 11800)] })).json();
    expect(booked()).toBe(1);
    expect(j.done.map((d: { txnId: string }) => d.txnId)).toEqual([L1]);
    const why = Object.fromEntries(j.refused.map((r: { txnId: string; reason: string }) => [r.txnId, r.reason]));
    expect(why[L2]).toMatch(/Already reconciled/);
    expect(why[LOCKED]).toMatch(/locked month/);
    expect(why[OTHER_CO]).toMatch(/Not a bank line of this account/);
  });

  it("money exact: a row whose amount is not the line's is refused, nothing booked", async () => {
    const j = await (await call({ accountId: ACCOUNT, rows: [row(L1, 11801)] })).json();
    expect(booked()).toBe(0);
    expect(j.refused[0].reason).toMatch(/amount or date/);
    expect(st.rpcs.some(([fn]) => fn === "bank_recon_run_start")).toBe(false);
  });

  it("a customer the app does not have yet is refused (the page creates it first)", async () => {
    const newCust = { kind: "new", zohoId: "z9", name: "New Co", gstin: null, stateCode: "07", state: "Delhi", country: "India", email: null, phone: null, contactName: "A", gstTreatment: null, customerType: "business" } as PlanRow["customer"];
    const j = await (await call({ accountId: ACCOUNT, rows: [row(L1, 11800, "2025-10-10", newCust)] })).json();
    expect(booked()).toBe(0);
    expect(j.refused[0].reason).toMatch(/not in the app yet/);
  });

  it("more than 10 rows, or no account, is a bad request", async () => {
    const many = Array.from({ length: 11 }, () => row(L1, 11800));
    expect((await call({ accountId: ACCOUNT, rows: many })).status).toBe(400);
    expect((await call({ rows: [row(L1, 11800)] })).status).toBe(400);
    expect(st.rpcs).toEqual([]);
  });
});
