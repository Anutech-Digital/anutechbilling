/**
 * R-2095 (30 Oct 2026, September reconcile on staging): a half-yearly NEW SALE booked from a bank
 * receipt auto-created a 'sent' payment request for the next half at sale time. The call made
 * right after a sale's payment (raise-instalments with afterSale) raises the paid part's invoice
 * only — a next-period request is made by the billing job / renewal flow on its own date, never
 * at sale time.
 */
import { describe, it, expect } from "vitest";
import { syncSubscriptionInstalments } from "./sync-instalments.server";
import { raiseFirstInstalment } from "@/lib/queries/bank-credit-pay-for";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, rpc: (fn: string, args: Row) => unknown) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return b; },
      neq: () => b, not: () => b, limit: () => b, order: () => b, update: () => b, insert: () => b,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: (x: { data: Row[] | null; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return b;
  };
  return { from, rpc: (fn: string, args: Row) => Promise.resolve({ data: rpc(fn, args), error: null }) } as never;
}

const TODAY = "2026-10-30";
const START = "2026-04-01";
const sub = {
  id: "s1", tenant_id: "t1", quote_id: null, mrr: 1000, billing_cycle: "half_yearly" as const, term_months: 12,
  start_date: START, renewal_date: "2027-03-31", external_source: null, external_ref: null, billed_externally_until: null,
};
/* H1 1 Apr (paid by the sale), H2 1 Oct — both dates have come. */
const parts = [1, 2].map((i) => ({
  id: `b${i}`, subscription_id: "s1", term_start: START, period_index: i,
  bill_on: ["2026-04-01", "2026-10-01"][i - 1], taxable_amount: 6000, invoice_id: null, credited_invoice_ids: [],
}));

function run(noNewRequests?: boolean) {
  const live: Row[] = [];
  const db = fakeDb({ subscription_billings: parts, quotes: [] }, (fn, args) => {
    if (fn !== "bill_subscription_instalment") return null;
    if (!args.p_dry_run) live.push(args);
    return args.p_billing_id === "b1"
      ? (args.p_dry_run ? { action: "invoice", gross: 7080, dry_run: true } : { action: "invoice", invoice_id: "INV-1", gross: 7080 })
      : (args.p_dry_run ? { action: "request", gross: 7080, dry_run: true } : { action: "request", quote_id: "Q-NEXT", created: true, gross: 7080 });
  });
  return syncSubscriptionInstalments({ supabase: db, sub, quote: undefined, todayISO: TODAY, ...(noNewRequests ? { noNewRequests } : {}) })
    .then((r) => ({ r, live }));
}

describe("R-2095 no next-period request at sale time", () => {
  it("after a sale (noNewRequests): H1 invoiced, H2 gets NO request", async () => {
    const { r, live } = await run(true);
    expect(r.raised.map((x) => x.invoice_id)).toEqual(["INV-1"]);
    expect(r.requests).toEqual([]);
    expect(live.map((c) => c.p_billing_id)).toEqual(["b1"]);
    expect(r.requestsHeld).toEqual([2]);
  });
  it("the billing job (default) still makes the due part's request on its own run", async () => {
    const { r } = await run();
    expect(r.requests.map((x) => x.quote_id)).toEqual(["Q-NEXT"]);
  });
  it("the reconcile new sale posts afterSale to raise-instalments", async () => {
    const bodies: unknown[] = [];
    const post = (async (_u: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ raised: [{ invoice_id: "INV-1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = { quote_id: "Q-1", already_recorded: false, invoice_issued: null } as unknown as PayForResult;
    expect((await raiseFirstInstalment(r, "half_yearly", post)).invoice_issued).toBe("INV-1");
    expect(bodies).toEqual([{ afterSale: true }]);
  });
});
