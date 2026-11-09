/**
 * R-2626 — readLaterBilledParts: which later parts already have a bill. Pins the same rows the SQL
 * trigger subscriptions_r2626_plan_change_vs_later_part reads: a live (not void) invoice, or a payment
 * request still linked to the part — directly or as a GROUP request's line (R-2092), any status — not
 * spent on an invoice credit notes cancelled (R-2095). A cancelled proforma (unlinked) or a freed part
 * is not a bill; another company's rows are never read; a failed read throws.
 */
import { describe, expect, it } from "vitest";
import { readLaterBilledParts } from "./change-plan-later-parts.server";

type Row = Record<string, unknown>;

function client(tables: Record<string, Row[]>, failOn?: string) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    calls.push({ table, filters });
    const run = async () => {
      if (failOn === table) return { data: null, error: { message: "boom" } };
      const rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) => {
        if (op === "eq") return r[c] === v;
        if (op === "gt") return String(r[c]) > String(v);
        if (op === "in") return (v as unknown[]).includes(r[c]);
        if (op === "notnull") return r[c] != null;
        if (op === "cs") {
          const want = (JSON.parse(String(v)) as Row[])[0];
          return Array.isArray(r[c]) && (r[c] as Row[]).some((l) => Object.entries(want).every(([k, x]) => l[k] === x));
        }
        return true;
      }));
      return { data: rows, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
      gt: (c: string, v: unknown) => { filters.push(["gt", c, v]); return q; },
      in: (c: string, v: unknown) => { filters.push(["in", c, v]); return q; },
      not: (c: string, op: string, v: unknown) => { if (op === "is" && v === null) filters.push(["notnull", c, null]); return q; },
      contains: (c: string, v: unknown) => { filters.push(["cs", c, v]); return q; },
      then: (ok: (r: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
    };
    return q;
  };
  return { db: { from }, calls };
}

const T = "T1";
const part = (n: number, start: string, end: string, invoice_id: string | null = null, extra: Row = {}) =>
  ({ id: `B${n}`, tenant_id: T, subscription_id: "S1", period_index: n, period_start: start, period_end: end, invoice_id,
     credited_invoice_ids: [], ...extra });
const req = (id: string, billing: string | null, extra: Row = {}) =>
  ({ id, tenant_id: T, subscription_billing_id: billing, invoice_id: null, line_items: [], created_at: "2026-09-01", ...extra });

describe("R-2626 readLaterBilledParts", () => {
  const billings = [
    part(2, "2026-07-01", "2026-10-01", "INV-2"),                                    // current part — not after `after`
    part(3, "2026-10-01", "2027-01-01", "INV-3"),                                    // invoiced ahead (live)
    part(4, "2027-01-01", "2027-04-01", "INV-4V"),                                   // its invoice is void
    part(5, "2027-04-01", "2027-07-01"),                                             // open proforma
    part(6, "2027-07-01", "2027-10-01"),                                             // on a GROUP request's line
    part(7, "2027-10-01", "2028-01-01"),                                             // expired by date, still linked
    part(8, "2028-01-01", "2028-04-01", null, { credited_invoice_ids: ["INV-8C"] }), // its request spent on a credited invoice
    part(9, "2028-04-01", "2028-07-01"),                                             // proforma cancelled (unlinked)
    { ...part(10, "2028-07-01", "2028-10-01"), tenant_id: "T2" },                    // another company's row
  ];
  const invoices = [
    { id: "INV-2", tenant_id: T, status: "paid" },
    { id: "INV-3", tenant_id: T, status: "paid" },
    { id: "INV-4V", tenant_id: T, status: "void" },
  ];
  const quotes = [
    req("PI-5", "B5", { status: "sent" }),
    req("PI-G", "B-OTHER", { status: "sent", line_items: [{ billing_id: "B-OTHER" }, { billing_id: "B6" }] }),
    req("PI-7", "B7", { status: "expired" }),
    req("PI-8", "B8", { status: "accepted", invoice_id: "INV-8C" }),
    req("PI-9", null, { status: "rejected", cancelled_part_billing_id: "B9", line_items: [{ billing_id: "B9" }] }),
  ];

  it("live invoice / linked request (direct, group line, any status) count; void, credited-spent, cancelled, other tenant do not", async () => {
    const { db, calls } = client({ subscription_billings: billings, invoices, quotes });
    const parts = await readLaterBilledParts(db, T, "S1", "2026-09-15");
    expect(parts.map((p) => [p.periodIndex, p.invoiceId, p.requestId])).toEqual([
      [3, "INV-3", null],
      [4, null, null],
      [5, null, "PI-5"],
      [6, null, "PI-G"],
      [7, null, "PI-7"],
      [8, null, null],
      [9, null, null],
    ]);
    expect(parts[0]).toEqual({ periodIndex: 3, periodStart: "2026-10-01", periodEnd: "2027-01-01", invoiceId: "INV-3", requestId: null });
    for (const c of calls) expect(c.filters).toContainEqual(["eq", "tenant_id", T]);
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
