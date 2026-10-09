import { describe, it, expect } from "vitest";
import { summarizeCostFill, type CostFillRow } from "./cost-backfill";
import { invoiceMarginMtd } from "./margin-mtd";

const row = (p: Partial<CostFillRow>): CostFillRow => ({
  invoice_id: "INV-1", invoice_date: "2026-10-07", customer_name: "C", line_index: 0,
  line_name: "GW", qty: 10, rate: 3240, cost_new: 1320, source: "quote", blocked: null, ...p,
});

describe("R-487 summarizeCostFill", () => {
  it("counts quote / catalogue / missing and sends only fillable, unlocked invoices", () => {
    const s = summarizeCostFill([
      row({ invoice_id: "A", source: "quote" }),
      row({ invoice_id: "A", line_index: 1, source: "catalog" }),
      row({ invoice_id: "B", source: "missing", cost_new: null }),
      row({ invoice_id: "C", source: "quote", blocked: "books_locked" }),
    ]);
    expect(s).toMatchObject({ fillable: 2, fromQuote: 1, fromCatalog: 1, stillMissing: 1, locked: 1 });
    expect(s.invoiceIds).toEqual(["A"]);
  });

  it("nothing to fill → no invoices sent", () => {
    expect(summarizeCostFill([row({ source: "missing", cost_new: null })]).invoiceIds).toEqual([]);
  });
});

describe("R-487 margin with copied quote lines", () => {
  const now = new Date("2026-10-09T06:00:00Z");
  it("a quote invoice whose lines now carry cost shows a real margin", () => {
    const m = invoiceMarginMtd([{
      status: "paid", invoice_date: "2026-10-07", amount: 38232, taxable_value: 32400, tax_amount: 5832,
      line_items: [{ qty: 10, rate: 3240, cost: 1320 }],
    }], now);
    expect(m).toMatchObject({ missingLines: 0, costedSales: 32400, cost: 13200, margin: 19200 });
  });

  it("a line whose cost is unknown everywhere (null) stays missing, never ₹0 cost", () => {
    const m = invoiceMarginMtd([{
      status: "paid", invoice_date: "2026-10-07", amount: 708, taxable_value: 600, tax_amount: 108,
      line_items: [{ qty: 1, rate: 600, cost: null }],
    }], now);
    expect(m.missingLines).toBe(1);
    expect(m.costedSales).toBe(0);
  });
});
