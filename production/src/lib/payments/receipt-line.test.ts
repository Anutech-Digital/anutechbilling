// R-1747 — the receipt voucher's description line. A payment on an invoice imported from Zoho
// Books is money against an old invoice, not an advance: owner's example ₹15,000 on INV-000245.
import { describe, it, expect } from "vitest";
import { receiptLine } from "./receipt-line";

describe("R-1747 receiptLine", () => {
  it("owner's example: payment on imported INV-000245 → 'Received against invoice INV-000245 (opening balance)', no GST", () => {
    expect(receiptLine({ openingInvoiceNumber: "INV-000245" })).toEqual({
      description: "Received against invoice INV-000245 (opening balance)",
      advance: false,
    });
  });
  it("a quote payment stays an advance receipt", () => {
    expect(receiptLine({ quoteId: "Q-0101" })).toEqual({ description: "Advance received against quote Q-0101", advance: true });
  });
  it("neither → advance against service (unchanged)", () => {
    expect(receiptLine({})).toEqual({ description: "Advance received against service", advance: true });
  });
});
