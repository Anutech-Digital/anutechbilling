// @vitest-environment jsdom
//
// R-1636 — a subscription instalment invoice has no quote of its own (invoices.quote_id is
// NULL, R-1564); its payment is recorded on the SUBSCRIPTION's quote (record_instalment_payment).
// The receipts panel looked only for the invoice's own quote, so after a payment it still said
// "No payment receipts recorded for this invoice yet", and the TDS banner never showed.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import type { Invoice, Payment } from "@/lib/supabase/database.types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SUB_QUOTE = "Q-SUB-1";
const receipt = {
  id: "pay-1", quote_id: SUB_QUOTE, amount: 590, status: "received", method: "upi",
  received_at: "2026-10-20T00:00:00Z", receipt_voucher_no: "RV-2026-27-0042",
} as unknown as Payment;
let instalmentLink: { subscriptionId: string; quoteId: string | null } | null = null;

vi.mock("@/lib/queries/quotes", () => ({ useQuoteByInvoiceId: () => ({ data: null, isLoading: false }) }));
vi.mock("@/lib/queries/payments", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/payments")>()),
  usePaymentsByQuote: (id: string | null | undefined) => ({ data: id === SUB_QUOTE ? [receipt] : [], isLoading: false }),
  useInstalmentLink: (id: string | null | undefined) => ({ data: id ? instalmentLink : null, isLoading: false }),
}));
vi.mock("@/lib/queries/projects", () => ({ useProjectPaymentsByInvoice: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomer: () => ({ data: null }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: null }) }));

import { InvoicePaymentsAccordion } from "./invoice-detail";
import { invoiceReceiptsQuote, invoiceTdsMoney } from "./invoice-receipts";

afterEach(cleanup);

const inv = {
  id: "INV-R36-0007", quote_id: null, customer_id: "c1", customer_name: "Instalment Co",
  amount: 1180, net_payable: 1180, paid_amount: 590, status: "pending", document_kind: "tax_invoice",
} as unknown as Invoice;

describe("instalment invoice receipts (R-1636)", () => {
  it("shows the receipt voucher recorded on the subscription's quote", () => {
    instalmentLink = { subscriptionId: "s1", quoteId: SUB_QUOTE };
    render(<InvoicePaymentsAccordion inv={inv} />);
    expect(screen.queryByText(/No payment receipts recorded/)).toBeNull();
    expect(screen.getByText("RV-2026-27-0042")).toBeTruthy();
    expect(screen.getByText(/oldest unpaid instalment first/)).toBeTruthy();
  });

  it("an invoice with no quote and no subscription still says there is nothing yet", () => {
    instalmentLink = null;
    render(<InvoicePaymentsAccordion inv={inv} />);
    expect(screen.getByText(/No payment receipts recorded for this invoice yet/)).toBeTruthy();
  });
});

describe("which quote's receipts, and the TDS banner's money (R-1636)", () => {
  it("own quote first, else the instalment's subscription quote, else none", () => {
    expect(invoiceReceiptsQuote("Q-OWN", { quoteId: SUB_QUOTE })).toEqual({ quoteId: "Q-OWN", instalment: false });
    expect(invoiceReceiptsQuote(null, { quoteId: SUB_QUOTE })).toEqual({ quoteId: SUB_QUOTE, instalment: true });
    expect(invoiceReceiptsQuote(undefined, { quoteId: null })).toBeNull();
    expect(invoiceReceiptsQuote(undefined, null)).toBeNull();
  });

  it("an instalment's banner reads THIS invoice's paid part, never the year's quote receipts", () => {
    // ₹2,55,000 + 18% = ₹3,00,900; ₹2,75,400 paid on it → ₹25,500 left (10% TDS)
    const money = invoiceTdsMoney({
      invoice: { amount: 300_900, net_payable: 300_900, paid_amount: 275_400, status: "pending" },
      source: { quoteId: SUB_QUOTE, instalment: true },
      quoteTotal: 3_610_800, quoteReceived: 999_999,
    });
    expect(money).toEqual({ total: 300_900, received: 275_400 });
  });

  it("an invoice with its own quote keeps the quote's total and receipts (R-1520)", () => {
    const money = invoiceTdsMoney({
      invoice: { amount: 300_900, net_payable: 300_900, paid_amount: 0, status: "pending" },
      source: { quoteId: "Q-OWN", instalment: false },
      quoteTotal: 300_900, quoteReceived: 275_400,
    });
    expect(money).toEqual({ total: 300_900, received: 275_400 });
    expect(invoiceTdsMoney({ invoice: { amount: 1 }, source: null, quoteTotal: 0, quoteReceived: 0 })).toBeNull();
  });
});
