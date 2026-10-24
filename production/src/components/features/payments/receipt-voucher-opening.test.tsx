// @vitest-environment jsdom
/* R-1747 — the receipt voucher of a payment on an imported Zoho invoice. Owner's example: ₹15,000
   on INV-000245 printed "Advance received against service" with CGST / SGST split out — but this
   is money against an old invoice whose GST was filed from Zoho Books, not an advance. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantLogoUrl: null } }) }));
vi.mock("@/lib/queries/tds-receivable", () => ({ useTdsForPayment: () => ({ data: 0 }) }));

import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import type { Payment } from "@/lib/supabase/database.types";

const payment = {
  id: "pay-245", quote_id: null, invoice_id: "INV-000245", amount: 15000, credit_applied: 0, status: "received",
  method: "bank_transfer", reference: "UTR-1", received_at: "2026-10-21T00:00:00Z", receipt_voucher_no: "RV-TZA-27-0009", notes: null,
} as unknown as Payment;

afterEach(cleanup);

describe("R-1747 receipt voucher on an imported invoice", () => {
  it("owner's example: 'Received against invoice INV-000245 (opening balance)', full ₹15,000, no GST split, no advance wording", () => {
    render(<ReceiptVoucherDialog open onOpenChange={() => {}} payment={payment} customerName="T-ABC Pvt Ltd"
      tenantName="Anutech" openingInvoiceNumber="INV-000245" />);
    const text = document.body.textContent ?? "";
    expect(screen.getByText("Received against invoice INV-000245 (opening balance)")).toBeTruthy();
    expect(text).not.toMatch(/Advance received/);
    expect(text).not.toMatch(/CGST|SGST|IGST/);
    expect(text).not.toMatch(/advance receipt|GST treatment of this advance/i);
    expect(text).toContain("Against invoice");
    expect(text).toContain("₹15,000");
  });

  it("a quote payment keeps the advance receipt (unchanged)", () => {
    render(<ReceiptVoucherDialog open onOpenChange={() => {}} payment={{ ...payment, quote_id: "Q-0101", invoice_id: null } as Payment}
      customerName="Acme" tenantName="Anutech" quoteId="Q-0101" />);
    expect(screen.getByText("Advance received against quote Q-0101")).toBeTruthy();
    expect(document.body.textContent).toMatch(/CGST/);
  });
});
