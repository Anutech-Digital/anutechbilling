/**
 * R-2095 (coordinator, 30 Oct 2026): a credit note for the WHOLE part invoice often means "customer
 * cancelled / we don't bill this". The freed part (credited_invoice_ids, migration 20261030035007)
 * must NOT be re-raised by the billing job or the auto-raise after a payment — only by the owner's
 * own "Generate invoice for Qn" (Invoices) or Generate (Renewals).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { syncSubscriptionInstalments } from "./sync-instalments.server";

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
const START = "2026-10-01";
const sub = {
  id: "s1", tenant_id: "t1", quote_id: null, mrr: 1000, billing_cycle: "quarterly" as const, term_months: 12,
  start_date: START, renewal_date: "2027-09-30", external_source: null, external_ref: null, billed_externally_until: null,
};
/* The four parts as laid; Q1 started 1 Oct, its invoice INV-1 credited in full (released). */
const parts = (credited: string[]) => [1, 2, 3, 4].map((i) => ({
  id: `b${i}`, subscription_id: "s1", term_start: START, period_index: i,
  bill_on: ["2026-10-01", "2027-01-01", "2027-04-01", "2027-07-01"][i - 1],
  taxable_amount: 3000, invoice_id: null, credited_invoice_ids: i === 1 ? credited : [],
}));

function run(credited: string[], rebillCredited?: boolean) {
  const calls: Row[] = [];
  const db = fakeDb({ subscription_billings: parts(credited), quotes: [] }, (fn, args) => {
    if (fn === "bill_subscription_instalment") { calls.push(args); return { action: "request", quote_id: "Q-9", gross: 3540 }; }
    return null;
  });
  return syncSubscriptionInstalments({ supabase: db, sub, quote: undefined, todayISO: TODAY, ...(rebillCredited ? { rebillCredited } : {}) })
    .then((r) => ({ r, calls }));
}

describe("R-2095 a credited part is re-billed only by hand", () => {
  it("the billing job (default) holds Q1 whose invoice credit notes cancelled — no bill call", async () => {
    const { r, calls } = await run(["INV-1"]);
    expect(calls.map((c) => c.p_billing_id)).not.toContain("b1");
    expect(r.heldCredited).toEqual([{ period_index: 1, credited: ["INV-1"] }]);
  });
  it("manual Generate (rebillCredited) bills it", async () => {
    const { r, calls } = await run(["INV-1"], true);
    expect(calls.map((c) => c.p_billing_id)).toContain("b1");
    expect(r.heldCredited ?? []).toEqual([]);
  });
  it("a part never credited is billed as before", async () => {
    const { calls } = await run([]);
    expect(calls.map((c) => c.p_billing_id)).toContain("b1");
  });
  it("only the two manual routes pass rebillCredited; the billing cron does not", () => {
    expect(readFileSync("src/app/api/quotes/[id]/raise-instalments/route.ts", "utf8")).toMatch(/rebillCredited:\s*true/);
    expect(readFileSync("src/app/api/subscriptions/[id]/generate-renewal-quote/route.ts", "utf8")).toMatch(/rebillCredited:\s*true/);
    expect(readFileSync("src/app/api/cron/billing/route.ts", "utf8")).not.toMatch(/rebillCredited/);
  });
});
