/* R-1917 — "Book as expense" on a vendor's bank line: refused when that vendor has an open item of
   the line's amount (R-1906 audit B8: Sharma's ₹11,800 bill PS-2 open → a new ₹11,800 expense
   doubled Sharma's cost). Same rule as the SQL guard in book_bank_txn_as_expense. */
import { describe, expect, it } from "vitest";

import type { VendorOpenItem } from "@/lib/banking/debit-pay-for";
import { expenseGuard, sameVendor } from "./vendor-line-guard";

const item = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "expense", doc_id: "E2", bill_no: "PS-2", doc_date: "2026-09-10", due_date: null, category: "Professional Services",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: false, in_run: null, ...o,
});
const sharma = (items: VendorOpenItem[]) => ({ vendorId: "v1", vendorName: "Sharma Associates", openItems: items });

describe("R-1917 expenseGuard", () => {
  it("B8: Sharma ₹11,800 line, Sharma's PS-2 ₹11,800 open → blocked, sentence names PS-2", () => {
    const g = expenseGuard(sharma([item({})]), "Sharma Associates", 11800);
    expect(g?.blocked).toBe(true);
    expect(g?.message).toBe("Sharma Associates has an open bill PS-2 for ₹11,800 — pay it with Record payment above instead of booking a new expense, or the cost is counted twice.");
  });

  it("the expense form's vendor typed in another case / with spaces is the same vendor", () => {
    expect(expenseGuard(sharma([item({})]), "  sharma associates ", 11800)?.blocked).toBe(true);
    expect(sameVendor("SHARMA  ASSOCIATES", "Sharma Associates")).toBe(true);
  });

  it("net of the TDS already on the bill: ₹59,000 bill with ₹5,000 TDS, ₹54,000 line → blocked", () => {
    const g = expenseGuard(sharma([item({ bill_no: "PS-3", amount_due: 59000, total: 59000, tds_amount: 5000 })]), "Sharma Associates", 54000);
    expect(g?.blocked).toBe(true);
    expect(g?.message).toContain("PS-3");
  });

  it("a payment already recorded on the Bills / Expenses page → blocked, says it is already recorded", () => {
    const g = expenseGuard(sharma([item({ source: "recorded_payment", paid_on: "2026-10-01", bill_no: "PS-2" })]), "Sharma Associates", 11800);
    expect(g?.blocked).toBe(true);
    expect(g?.message).toContain("already recorded as paid");
    expect(g?.message).toContain("PS-2");
  });

  it("open bills of another amount: not blocked, but named so the owner sees them", () => {
    const g = expenseGuard(sharma([item({ bill_no: "PS-9", amount_due: 59000 })]), "Sharma Associates", 500);
    expect(g?.blocked).toBe(false);
    expect(g?.message).toContain("PS-9");
  });

  it("another vendor typed in the form, no vendor, or nothing open → no guard", () => {
    expect(expenseGuard(sharma([item({})]), "Gupta Printers", 11800)).toBeNull();
    expect(expenseGuard(sharma([item({})]), "", 11800)).toBeNull();
    expect(expenseGuard(sharma([]), "Sharma Associates", 11800)).toBeNull();
    expect(expenseGuard(null, "Sharma Associates", 11800)).toBeNull();
  });
});
