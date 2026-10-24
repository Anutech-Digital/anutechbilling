/**
 * R-1742 — the GST report reads the GST treatment.
 *
 * Owner's example: an SEZ (with payment) invoice of ₹38,232 (₹32,400 + IGST ₹5,832) to an SEZ
 * unit in the seller's own state must file in GSTR-1 B2B as SEWP. And an advance from that
 * SEZ customer (receipt voucher, not invoiced yet) is IGST, not CGST + SGST — before this the
 * advance used the state rule only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { loadGstReport } from "./report";
import { toGstr1Doc } from "./cash-to-pay";
import { buildGstr1, gstr1Json } from "@/lib/gst/gstr1";

type Row = Record<string, unknown>;
const RANGE = { from: "2026-10-01", to: "2026-10-31", label: "Oct 2026" };

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

const SEZ_GSTIN = "07AAACS1234E1ZP";
const ROWS: Record<string, Row[]> = {
  tenants: [{ state_code: "07", state: "Delhi", gstin: "07AAAAA0000A1Z5" }],
  invoices: [{
    id: "INV-SEZ", amount: 38232, invoice_date: "2026-10-10", customer_name: "SEZ Unit", customer_id: "c1", status: "pending",
    taxable_value: 32400, tax_amount: 5832, tax_rate: 18, inter_state: true, line_items: [], adjusted_advances: [],
    customer_gstin: SEZ_GSTIN, pos_state_code: "07", customer_country: "India", billing_address: null, seller_state_code: "07",
    document_kind: "tax_invoice", gst_treatment: "sez_with_payment",
  }],
  customers: [{ id: "c1", gstin: SEZ_GSTIN, state_code: "07", state: "Delhi", country: "India", gst_treatment: "sez_with_payment" }],
  payments: [{ id: "p1", receipt_voucher_no: "RV-1", amount: 11800, credit_applied: 0, received_at: "2026-10-05T06:00:00Z", quote_id: "q1", customer_id: "c1", status: "received" }],
  quotes: [{ id: "q1", invoice_id: null, tax_rate: 18, customer_id: "c1" }],
};

describe("R-1742: GST report reads gst_treatment", () => {
  it("the SEZ invoice carries its frozen treatment and files as B2B SEWP with IGST ₹5,832", async () => {
    const r = await loadGstReport(client(ROWS), RANGE);
    const row = r.outputRows.find((o) => o.invoiceId === "INV-SEZ")!;
    expect(row.gstTreatment).toBe("sez_with_payment");
    const s = buildGstr1(r.outputRows.map(toGstr1Doc), { stateCode: "07", state: "Delhi" });
    expect(s.b2b[0]).toMatchObject({ id: "INV-SEZ", invType: "SEWP", heads: { igst: 5832, cgst: 0, sgst: 0 } });
    expect(gstr1Json(s, "07AAAAA0000A1Z5", "102026").b2b[0].inv[0].inv_typ).toBe("SEWP");
  });

  it("an advance from an SEZ customer in the seller's own state is IGST", async () => {
    const r = await loadGstReport(client(ROWS), RANGE);
    const adv = r.advances.find((a) => a.paymentId === "p1")!;
    expect(adv.interState).toBe(true);
  });
});
