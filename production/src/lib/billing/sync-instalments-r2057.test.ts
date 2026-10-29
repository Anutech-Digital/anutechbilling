/**
 * R-2057 — Generate on the Invoices page's pending row for a sale billed in parts runs the billing
 * cron's path (raiseDueInstalmentsForQuote). Its answer now carries the due parts that HAVE their
 * invoice, so a second Generate opens the same invoice instead of failing or making another.
 */
import { describe, it, expect } from "vitest";
import { duePartInvoices } from "./sync-instalments.server";

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const calls: { table: string; filters: string[] }[] = [];
  const from = (table: string) => {
    const filters: string[] = [];
    calls.push({ table, filters });
    let rows = [...(tables[table] ?? [])];
    const b: Record<string, unknown> = {
      select: () => b,
      in: (c: string, v: unknown[]) => { filters.push(`in:${c}`); rows = rows.filter((r) => v.includes(r[c])); return b; },
      not: (c: string) => { filters.push(`not:${c}`); rows = rows.filter((r) => r[c] != null); return b; },
      lte: (c: string, v: string) => { filters.push(`lte:${c}`); rows = rows.filter((r) => String(r[c]) <= v); return b; },
      eq: (c: string, v: unknown) => { filters.push(`eq:${c}`); rows = rows.filter((r) => r[c] === v); return b; },
      then: (res: (x: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return b;
  };
  return { db: { from } as never, calls };
}

const billings = [
  { id: "b1", subscription_id: "s1", period_index: 1, period_start: "2026-10-01", period_end: "2027-01-01", bill_on: "2026-10-01", invoice_id: "INV-7" },
  { id: "b2", subscription_id: "s1", period_index: 2, period_start: "2027-01-01", period_end: "2027-04-01", bill_on: "2027-01-01", invoice_id: null },
  { id: "b3", subscription_id: "s1", period_index: 3, period_start: "2027-04-01", period_end: "2027-07-01", bill_on: "2027-04-01", invoice_id: "INV-FUTURE" },
];

describe("duePartInvoices (R-2057)", () => {
  it("Q1 invoiced and due → reported with its part, period and amount; not-due and uninvoiced parts left out", async () => {
    const { db } = fakeDb({
      subscription_billings: billings,
      subscriptions: [{ id: "s1", billing_cycle: "quarterly" }],
      invoices: [{ id: "INV-7", amount: 95993 }],
    });
    const out = await duePartInvoices(db, { subscriptionIds: ["s1"], todayISO: "2026-10-28", raisedNow: new Set() });
    expect(out).toEqual([{
      subscription_id: "s1", period_index: 1, part: "Q1", invoice_id: "INV-7", gross: 95993,
      period_start: "2026-10-01", period_end: "2027-01-01", raised_now: false,
    }]);
  });

  it("raised by this call → raised_now true", async () => {
    const { db } = fakeDb({
      subscription_billings: billings,
      subscriptions: [{ id: "s1", billing_cycle: "quarterly" }],
      invoices: [{ id: "INV-7", amount: 95993 }],
    });
    const out = await duePartInvoices(db, { subscriptionIds: ["s1"], todayISO: "2026-10-28", raisedNow: new Set(["INV-7"]) });
    expect(out[0].raised_now).toBe(true);
  });

  it("a part's own request → only that part", async () => {
    const { db, calls } = fakeDb({
      subscription_billings: billings,
      subscriptions: [{ id: "s1", billing_cycle: "quarterly" }],
      invoices: [{ id: "INV-7", amount: 95993 }],
    });
    const out = await duePartInvoices(db, { subscriptionIds: ["s1"], todayISO: "2027-05-01", raisedNow: new Set(), onlyBillingId: "b3" });
    expect(out.map((x) => x.invoice_id)).toEqual(["INV-FUTURE"]);
    expect(calls[0].filters).toContain("eq:id");
  });

  it("no subscriptions → no reads", async () => {
    const { db, calls } = fakeDb({});
    expect(await duePartInvoices(db, { subscriptionIds: [], todayISO: "2026-10-28", raisedNow: new Set() })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
