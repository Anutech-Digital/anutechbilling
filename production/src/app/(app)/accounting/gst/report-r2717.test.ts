/**
 * R-2717 — the GST report reads the GST rate of each LINE.
 *
 * Owner's example (R-2702: INV/25-26/1248, 1953, 2065): one invoice, a 0% line ₹10,000 and an
 * 18% line ₹20,000, IGST ₹3,600, total ₹33,600; invoices.tax_rate is NULL (no single rate).
 * Before: docGstRate derived ONE slab from tax ÷ taxable (12%) and GSTR-1 filed ₹30,000 at it.
 * A credit note on it (tax_rate NULL) is split like the invoice.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { loadGstReport } from "./report";
import { toGstr1Doc } from "./cash-to-pay";
import { buildGstr1, gstr1Csv } from "@/lib/gst/gstr1";
import { outputRateLabel } from "@/lib/gst/line-rates";

type Row = Record<string, unknown>;
const RANGE = { from: "2025-11-01", to: "2025-11-30", label: "Nov 2025" };

function client(rows: Record<string, Row[]>) {
  const builder = (table: string) => {
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "gt", "gte", "lte", "lt", "not", "or", "order", "limit", "range"]) b[m] = () => b;
    b.maybeSingle = () => { single = true; return b; };
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const data = rows[table] ?? [];
      return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(res, rej);
    };
    return b;
  };
  return { from: builder, rpc: builder } as never;
}

const GSTIN = "29AAACA1111A1Z5";
const party = { customer_gstin: GSTIN, pos_state_code: "29", customer_country: "India", billing_address: null, seller_state_code: "07", document_kind: "tax_invoice", gst_treatment: "regular" };
const ROWS: Record<string, Row[]> = {
  tenants: [{ state_code: "07", state: "Delhi", gstin: "07AAAAA0000A1Z5" }],
  invoices: [
    {
      id: "INV/25-26/1248", amount: 33600, invoice_date: "2025-11-10", customer_name: "Acme", customer_id: "c1", status: "pending",
      taxable_value: 30000, tax_amount: 3600, tax_rate: null, inter_state: true, adjusted_advances: [],
      line_items: [
        { name: "Domain renewal", hsn: "998315", qty: 1, rate: 10000, amount: 10000, tax_rate: 0 },
        { name: "Workspace", hsn: "998313", qty: 2, rate: 10000, amount: 20000, tax_rate: 18 },
      ],
      ...party,
    },
    {
      id: "INV-PLAIN", amount: 11800, invoice_date: "2025-11-12", customer_name: "Acme", customer_id: "c1", status: "paid",
      taxable_value: 10000, tax_amount: 1800, tax_rate: 18, inter_state: true, adjusted_advances: [],
      line_items: [{ name: "Workspace", hsn: "998313", qty: 1, rate: 10000 }],
      ...party,
    },
  ],
  credit_notes: [
    // Half of the mixed invoice, issued by R-2717's issue_credit_note: no single rate.
    { id: "CN-MIX", invoice_id: "INV/25-26/1248", credit_date: "2025-11-20", customer_name: "Acme", customer_id: "c1", amount: 16800, taxable_value: 15000, tax_amount: 1800, tax_rate: null, inter_state: true },
    // An ordinary 18% note keeps its own rate.
    { id: "CN-PLAIN", invoice_id: "INV-PLAIN", credit_date: "2025-11-21", customer_name: "Acme", customer_id: "c1", amount: 1180, taxable_value: 1000, tax_amount: 180, tax_rate: 18, inter_state: true },
  ],
  customers: [{ id: "c1", gstin: GSTIN, state_code: "29", state: "Karnataka", country: "India", gst_treatment: "regular" }],
};

describe("R-2717: GST report by line rate", () => {
  it("the mixed invoice shows both rates (not a derived 12%) and GSTR-1 B2B splits it 0% / 18%", async () => {
    const r = await loadGstReport(client(ROWS), RANGE);
    const row = r.outputRows.find((o) => o.invoiceId === "INV/25-26/1248")!;
    expect(row).toMatchObject({ taxableValue: 30000, gst: 3600, taxRate: 18, rates: [0, 18], rateMissing: false });
    expect(outputRateLabel({ isExport: false, gst: row.gst, interState: row.interState, taxRate: row.taxRate, rates: row.rates })).toBe("IGST 0% + 18%");
    expect(r.rateMissingDocs).toBe(0);

    const s = buildGstr1(r.outputRows.map(toGstr1Doc), { stateCode: "07", state: "Delhi" });
    const lines = gstr1Csv(s).b2b.filter((l) => l[2] === "INV/25-26/1248").map((l) => [l[4], l[10], l[11]]);
    expect(lines).toEqual([[33600, 0, 10000], [33600, 18, 20000]]);
    // The plain invoice: one line, its own rate, no `rates`.
    expect(r.outputRows.find((o) => o.invoiceId === "INV-PLAIN")).toMatchObject({ taxRate: 18 });
    expect(r.outputRows.find((o) => o.invoiceId === "INV-PLAIN")?.rates).toBeUndefined();
    expect(gstr1Csv(s).b2b.filter((l) => l[2] === "INV-PLAIN").map((l) => [l[10], l[11]])).toEqual([[18, 10000]]);
  });

  it("a credit note with no rate of its own is split like its invoice; one with a rate keeps it", async () => {
    const r = await loadGstReport(client(ROWS), RANGE);
    expect(r.outputRows.find((o) => o.invoiceId === "CN-MIX")).toMatchObject({ taxableValue: -15000, gst: -1800, rates: [0, 18], rateMissing: false });
    const s = buildGstr1(r.outputRows.map(toGstr1Doc), { stateCode: "07", state: "Delhi" });
    expect(gstr1Csv(s).cdnr.map((l) => [l[2], l[8], l[10], l[11]])).toEqual(expect.arrayContaining([
      ["CN-MIX", 16800, 0, 5000], ["CN-MIX", 16800, 18, 10000], ["CN-PLAIN", 1180, 18, 1000],
    ]));
    expect(gstr1Csv(s).cdnr).toHaveLength(3);
    // HSN nets per SAC + rate: 998315 @0: 10,000 − 5,000; 998313 @18: 20,000 + 10,000 − 10,000 − 1,000.
    expect(s.hsn.map((h) => [h.hsn, h.rate, h.taxable, h.heads.igst]).sort()).toEqual([
      ["998313", 18, 19000, 3420], ["998315", 0, 5000, 0],
    ]);
    // Totals still tie to the documents.
    expect(r.outputGST).toBe(3600 + 1800 - 1800 - 180);
  });

  it("an old note carrying its own rate on a mixed invoice is NOT re-split by the invoice's lines", async () => {
    const rows = { ...ROWS, credit_notes: [{ ...ROWS.credit_notes[0], tax_rate: 18, taxable_value: 14237, tax_amount: 2563 }] };
    const r = await loadGstReport(client(rows), RANGE);
    const s = buildGstr1(r.outputRows.map(toGstr1Doc), { stateCode: "07", state: "Delhi" });
    expect(gstr1Csv(s).cdnr.map((l) => [l[2], l[10], l[11]])).toEqual([["CN-MIX", 18, 14237]]);
  });
});
