/**
 * R-1581 — the GST report fails CLOSED (CLAUDE.md §17c).
 *
 * Before R-1586 only the invoices read was checked: a failed credit-note, advance, bill or
 * expense read came back as "no rows", so GSTR-1 / 3B showed more output tax or less ITC with
 * no warning. R-1586 moved every list read to fetchAllRows (which throws); the seller's own
 * state read still ignored its error — a missing state code turns intra-state sales into IGST.
 * Every read failing must reject the whole report, so the page shows "didn't load", never a
 * wrong figure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { loadGstReport } from "./report";

type Row = Record<string, unknown>;
const RANGE = { from: "2026-09-01", to: "2026-09-30", label: "Sep 2026" };

/** Every table answers with `rows[table]` (or nothing) — except `failing`, which errors. */
function client(failing: string, rows: Record<string, Row[]> = {}) {
  const builder = (table: string) => {
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "gt", "gte", "lte", "lt", "not", "or", "order", "limit", "range"]) b[m] = () => b;
    b.maybeSingle = () => { single = true; return b; };
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === failing) return Promise.resolve({ data: null, error: { code: "57014", message: `${table}: statement timeout` } }).then(res, rej);
      const data = rows[table] ?? [];
      return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(res, rej);
    };
    return b;
  };
  return { from: builder, rpc: builder } as never;
}

/* One row per source so every lookup after it runs. */
const ROWS: Record<string, Row[]> = {
  tenants: [{ state_code: "07", state: "Delhi", gstin: "07AAAAA0000A1Z5" }],
  invoices: [{
    id: "i1", amount: 1180, invoice_date: "2026-09-10", customer_name: "C", customer_id: "c1", status: "pending",
    taxable_value: 1000, tax_amount: 180, tax_rate: 18, inter_state: false, line_items: [], adjusted_advances: [],
    customer_gstin: null, pos_state_code: "07", customer_country: "India", billing_address: null, seller_state_code: "07",
    document_kind: "tax_invoice",
  }],
  customers: [{ id: "c1", gstin: null, state_code: "07", state: "Delhi", country: "India" }],
};

describe("GST report: any failed read fails the report (R-1581)", () => {
  it("loads when nothing fails (control)", async () => {
    const r = await loadGstReport(client("none", ROWS), RANGE);
    expect(r.outputGST).toBe(180);
  });

  it.each(["tenants", "invoices", "credit_notes", "debit_notes", "payments", "customers", "vendor_bills", "expenses"])(
    "%s read fails → the report rejects, no figure",
    async (table) => {
      await expect(loadGstReport(client(table, ROWS), RANGE)).rejects.toMatchObject({ message: `${table}: statement timeout` });
    },
  );
});
