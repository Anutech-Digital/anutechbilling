// @vitest-environment jsdom
//
// R-2542 — an FY sale imported from Zoho (zoho_invoice_id, no quote) takes its receipt on the invoice
// itself (payments.invoice_id, quote_id NULL — bank Reconcile or the several-invoices sheet). The
// invoice page looked only for receipts on a quote, so after the bank line paid it the page still said
// "No payment receipts recorded for this invoice yet", and it had no Record payment button (canPay).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen } from "@testing-library/react";
import type { Invoice, Payment } from "@/lib/supabase/database.types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const receipt = {
  id: "pay-1913", quote_id: null, invoice_id: "INV/25-26/1913", amount: 87696, status: "received", method: "bank_transfer",
  received_at: "2026-01-05T00:00:00Z", receipt_voucher_no: "RV-2025-26-0913",
} as unknown as Payment;
const asked: Array<string | null | undefined> = [];

vi.mock("@/lib/queries/quotes", () => ({ useQuoteByInvoiceId: () => ({ data: null, isLoading: false }) }));
vi.mock("@/lib/queries/payments", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/payments")>()),
  usePaymentsByQuote: () => ({ data: [], isLoading: false }),
  useInstalmentLink: () => ({ data: null, isLoading: false }),
}));
vi.mock("@/lib/queries/quoteless-receipts", () => ({
  useQuotelessReceipts: (id: string | null | undefined) => {
    asked.push(id);
    return { data: id ? [receipt] : [], isLoading: false };
  },
}));
vi.mock("@/lib/queries/projects", () => ({ useProjectPaymentsByInvoice: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomer: () => ({ data: null }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: null }) }));

import { InvoicePaymentsAccordion } from "./invoice-detail";

afterEach(() => { cleanup(); asked.length = 0; });

const zohoSale = {
  id: "INV/25-26/1913", quote_id: null, customer_id: "c1", customer_name: "Suresh", zoho_invoice_id: "z1913",
  amount: 89208, net_payable: 89208, paid_amount: 89208, status: "paid", document_kind: "tax_invoice",
} as unknown as Invoice;

describe("Zoho FY sale receipts on the invoice page (R-2542)", () => {
  it("shows the receipt recorded on the invoice itself", () => {
    render(<InvoicePaymentsAccordion inv={zohoSale} />);
    expect(screen.queryByText(/No payment receipts recorded/)).toBeNull();
    expect(screen.getByText("RV-2025-26-0913")).toBeTruthy();
    expect(asked).toContain("INV/25-26/1913");
  });

  it("a hand-made invoice with no quote and no Zoho id does not read quote-less receipts", () => {
    render(<InvoicePaymentsAccordion inv={{ ...zohoSale, zoho_invoice_id: null } as unknown as Invoice} />);
    expect(screen.getByText(/No payment receipts recorded for this invoice yet/)).toBeTruthy();
    expect(asked.every((id) => !id)).toBe(true);
  });

  it("the page offers Record payment for it (canPay)", () => {
    const src = readFileSync(join(__dirname, "invoice-detail.tsx"), "utf8");
    expect(src).toMatch(/const canPay = [^;]*takesQuotelessReceipt\(invoice\)/);
  });
});
