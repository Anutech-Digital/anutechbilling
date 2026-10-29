import { describe, it, expect } from "vitest";
import { partInvoiceIds } from "./part-invoices";

/* R-2101: a 2-subscription quarterly sale has ONE Q1 invoice shared by both subscriptions' parts. */
describe("partInvoiceIds (R-2101)", () => {
  it("the combined Q1 invoice is listed once, however many parts point at it", () => {
    expect(partInvoiceIds([
      { invoice_id: "INV-1111-27-0016", period_start: "2026-10-22" },
      { invoice_id: "INV-1111-27-0016", period_start: "2026-10-22" },
    ], new Set())).toEqual(["INV-1111-27-0016"]);
  });
  it("in period order, void and empty left out", () => {
    expect(partInvoiceIds([
      { invoice_id: "INV-Q2", period_start: "2027-01-22" },
      { invoice_id: null, period_start: "2027-04-22" },
      { invoice_id: "INV-VOID", period_start: "2026-10-22" },
      { invoice_id: "INV-Q1", period_start: "2026-10-22" },
    ], new Set(["INV-VOID"]))).toEqual(["INV-Q1", "INV-Q2"]);
  });
});
