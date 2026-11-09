/**
 * R-2626 — readLaterBilledParts: which later parts already have a bill. Pins the same rows the SQL
 * trigger subscriptions_r2626_plan_change_vs_later_part reads: a live (not void) invoice, or an open
 * payment request (draft / sent / viewed / accepted); a freed part (no invoice_id) or a cancelled
 * proforma is not a bill; another company's rows are never read; a failed read throws.
 */
import { describe, expect, it } from "vitest";
import { readLaterBilledParts, OPEN_REQUEST_STATUSES } from "./change-plan-later-parts.server";

type Row = Record<string, unknown>;

function client(tables: Record<string, Row[]>, failOn?: string) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    calls.push({ table, filters });
    const run = async () => {
      if (failOn === table) return { data: null, error: { message: "boom" } };
      const rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) =>
        op === "eq" ? r[c] === v
        : op === "gt" ? String(r[c]) > String(v)
        : op === "in" ? (v as unknown[]).includes(r[c])
        : true));
      return { data: rows, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
      gt: (c: string, v: unknown) => { filters.push(["gt", c, v]); return q; },
      in: (c: string, v: unknown) => { filters.push(["in", c, v]); return q; },
      order: () => q,
      then: (ok: (r: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
    };
    return q;
  };
  return { db: { from }, calls };
}

const T = "T1";
const part = (n: number, start: string, end: string, invoice_id: string | null = null, tenant_id = T) =>
  ({ id: `B${n}`, tenant_id, subscription_id: "S1", period_index: n, period_start: start, period_end: end, invoice_id });

describe("R-2626 readLaterBilledParts", () => {
  const billings = [
    part(2, "2026-07-01", "2026-10-01", "INV-2"),           // current part — not after `after`
    part(3, "2026-10-01", "2027-01-01", "INV-3"),           // invoiced ahead (live)
    part(4, "2027-01-01", "2027-04-01", "INV-4V"),          // its invoice is void
    part(5, "2027-04-01", "2027-07-01"),                     // laid, no bill
    part(6, "2027-07-01", "2027-10-01", null, "T2"),        // another company's row
  ];
  const invoices = [
    { id: "INV-2", tenant_id: T, status: "paid" },
    { id: "INV-3", tenant_id: T, status: "paid" },
    { id: "INV-4V", tenant_id: T, status: "void" },
  ];
  const quotes = [
    { id: "PI-5", tenant_id: T, subscription_billing_id: "B5", status: "sent", created_at: "2026-09-01" },
    { id: "PI-4X", tenant_id: T, subscription_billing_id: "B4", status: "rejected", created_at: "2026-09-01" },
  ];

  it("live invoice / open proforma count; void invoice, cancelled proforma, other tenant do not", async () => {
    const { db, calls } = client({ subscription_billings: billings, invoices, quotes });
    const parts = await readLaterBilledParts(db, T, "S1", "2026-09-15");
    expect(parts).toEqual([
      { periodIndex: 3, periodStart: "2026-10-01", periodEnd: "2027-01-01", invoiceId: "INV-3", requestId: null },
      { periodIndex: 4, periodStart: "2027-01-01", periodEnd: "2027-04-01", invoiceId: null, requestId: null },
      { periodIndex: 5, periodStart: "2027-04-01", periodEnd: "2027-07-01", invoiceId: null, requestId: "PI-5" },
    ]);
    for (const c of calls) expect(c.filters).toContainEqual(["eq", "tenant_id", T]);
    expect(calls.find((c) => c.table === "quotes")!.filters).toContainEqual(["in", "status", [...OPEN_REQUEST_STATUSES]]);
  });

  it("no later parts → no further reads", async () => {
    const { db, calls } = client({ subscription_billings: [part(2, "2026-07-01", "2026-10-01", "INV-2")] });
    expect(await readLaterBilledParts(db, T, "S1", "2026-09-15")).toEqual([]);
    expect(calls.map((c) => c.table)).toEqual(["subscription_billings"]);
  });

  it.each(["subscription_billings", "invoices", "quotes"])("%s read fails → throws (caller refuses)", async (table) => {
    const { db } = client({ subscription_billings: billings, invoices, quotes }, table);
    await expect(readLaterBilledParts(db, T, "S1", "2026-09-15")).rejects.toThrow(/Could not read/);
  });
});
