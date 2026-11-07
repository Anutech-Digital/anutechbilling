// @vitest-environment jsdom
//
// R-2542 — staging Excel, 6 Nov: INV/25-26/1913 (an FY sale imported from Zoho — zoho_invoice_id, no
// quote, no instalment) → Invoices → Record payment said "This invoice is not linked to a quote or a
// subscription instalment". Such an invoice takes its receipt on the invoice itself (R-2501), so Record
// payment opens the several-invoices sheet for its customer (amount, date, mode, reference, TDS per
// line) — the same sheet a Zoho opening invoice (R-1739) already opens. The quote path is unchanged.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; isError?: boolean };
const state: { quote: Q<Record<string, unknown> | null> } = { quote: { data: null, isLoading: false } };
const multiProps = vi.fn();

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/quotes", () => ({ useQuoteByInvoiceId: () => state.quote }));
vi.mock("@/lib/queries/payments", () => ({
  usePaymentsByQuote: () => ({ data: [] }),
  totalReceived: () => 0,
  useInstalmentLink: () => ({ data: null, isLoading: false }),
}));
vi.mock("@/components/features/quotes/record-payment-dialog", () => ({
  RecordPaymentDialog: (p: Record<string, unknown>) => <div data-testid="quote-sheet">sheet for {String(p.quoteId)}</div>,
}));
vi.mock("@/components/features/payments/multi-invoice-payment-dialog", () => ({
  MultiInvoicePaymentDialog: (p: Record<string, unknown>) => {
    multiProps(p);
    return <div data-testid="multi-sheet">several invoices for {String(p.customerId)}</div>;
  },
}));

import { RecordSubscriptionPaymentContainer } from "./record-invoice-payment";
import type { Invoice } from "@/lib/supabase/database.types";

const zohoSale = {
  id: "INV/25-26/1913", customer_id: "c-suresh", customer_name: "Suresh", document_kind: "tax_invoice",
  amount: 89208, net_payable: 89208, paid_amount: 0, status: "overdue", quote_id: null, zoho_invoice_id: "460000001913",
} as unknown as Invoice;

beforeEach(() => {
  multiProps.mockClear();
  state.quote = { data: null, isLoading: false };
});
afterEach(cleanup);

describe("Record payment on an FY sale imported from Zoho (R-2542)", () => {
  it("opens the several-invoices sheet for its customer — not 'not linked to a quote'", () => {
    render(<RecordSubscriptionPaymentContainer invoice={zohoSale} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/not linked to a quote/i)).toBeNull();
    expect(screen.getByTestId("multi-sheet")).toBeTruthy();
    expect(multiProps.mock.calls.at(-1)![0]).toMatchObject({ customerId: "c-suresh", customerName: "Suresh", open: true });
  });

  it("a hand-made tax invoice with no quote and no Zoho id still explains why (no payment path)", () => {
    const hand = { ...zohoSale, zoho_invoice_id: null } as unknown as Invoice;
    render(<RecordSubscriptionPaymentContainer invoice={hand} open onOpenChange={() => {}} />);
    expect(screen.getByText(/not linked to a quote or a subscription instalment/i)).toBeTruthy();
    expect(screen.queryByTestId("multi-sheet")).toBeNull();
  });

  it("an invoice with its own quote keeps the quote sheet (unchanged)", () => {
    state.quote = { data: { id: "Q-9", amount: 1180, customer_name: "Suresh", is_one_off: true }, isLoading: false };
    const quoted = { ...zohoSale, id: "INV-Q9", quote_id: "Q-9", zoho_invoice_id: null } as unknown as Invoice;
    render(<RecordSubscriptionPaymentContainer invoice={quoted} open onOpenChange={() => {}} />);
    expect(screen.getByTestId("quote-sheet").textContent).toContain("Q-9");
    expect(screen.queryByTestId("multi-sheet")).toBeNull();
  });
});
