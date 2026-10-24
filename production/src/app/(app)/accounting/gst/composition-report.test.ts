/**
 * R-1530 — the composition report loader: notes carry the bill they are against, and any
 * failed read rejects (the card shows "didn't load", never ₹0 — §17c).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { gstr4Year } from "@/lib/compliance/composition-return";
import { loadCompositionRows } from "./composition-report";

type Row = Record<string, unknown>;
const FY = { from: "2026-04-01", to: "2027-03-31" };

/** Each table answers `rows[table]`; an `.in("id", …)` on invoices answers `bills`. */
function client(failing: string, rows: Record<string, Row[]>, bills: Row[]) {
  const builder = (table: string) => {
    let byId = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lte", "order", "range"]) b[m] = () => b;
    b.in = (col: string) => { if (col === "id") byId = true; return b; };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === failing) return Promise.resolve({ data: null, error: { code: "57014", message: `${table}: statement timeout` } }).then(res, rej);
      return Promise.resolve({ data: table === "invoices" && byId ? bills : rows[table] ?? [], error: null }).then(res, rej);
    };
    return b;
  };
  return { from: builder } as never;
}

const ROWS: Record<string, Row[]> = {
  invoices: [{ id: "b1", invoice_date: "2026-05-01", amount: 100000, taxable_value: 100000, status: "paid", document_kind: "bill_of_supply", supplier_gst_status: "composition" }],
  credit_notes: [
    { id: "cn1", invoice_id: "b1", credit_date: "2026-05-20", amount: 10000, taxable_value: 10000 },
    { id: "cn2", invoice_id: "t1", credit_date: "2026-05-21", amount: 5900, taxable_value: 5000 },
  ],
  debit_notes: [{ id: "dn1", invoice_id: "b1", debit_date: "2026-08-01", amount: 1000, taxable_value: 1000 }],
};
const BILLS: Row[] = [
  { id: "b1", document_kind: "bill_of_supply", supplier_gst_status: "composition" },
  { id: "t1", document_kind: "tax_invoice", supplier_gst_status: "registered" },
];

describe("loadCompositionRows", () => {
  it("attaches each note's bill, so only notes on composition bills count", async () => {
    const r = await loadCompositionRows(client("none", ROWS, BILLS), FY);
    expect(r.docs).toHaveLength(1);
    expect(r.notes).toHaveLength(3);
    const y = gstr4Year({ ...r, rate: 6, fyStartYear: 2026 });
    expect(y.quarters[0].netTurnover).toBe(90000);   // tax-invoice note ignored
    expect(y.quarters[1].netTurnover).toBe(1000);
    expect(y.tax).toBe(5400 + 60);
  });

  it.each(["invoices", "credit_notes", "debit_notes"])("%s read fails → rejects", async (table) => {
    await expect(loadCompositionRows(client(table, ROWS, BILLS), FY)).rejects.toMatchObject({ message: `${table}: statement timeout` });
  });
});
