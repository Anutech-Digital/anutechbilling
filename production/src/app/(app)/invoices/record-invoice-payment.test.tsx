// @vitest-environment jsdom
//
// R-1564 — Record payment on an INSTALMENT invoice (quarterly / monthly split-billed
// subscription) sat on "Loading payment…" forever: the container waited for "the quote whose
// invoice_id is this invoice", which an instalment never has (raise_subscription_billing
// leaves invoices.quote_id NULL; the link is subscription_billings.invoice_id). Now it finds
// the instalment's subscription quote and opens the sheet for THIS invoice's own due, a
// lookup error shows what happened + Retry (§24), and an invoice with neither link says so.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

type Q<T> = { data: T; isLoading: boolean; isError?: boolean; error?: unknown; refetch?: () => void };
const state: {
  quote: Q<Record<string, unknown> | null>;
  link: Q<{ subscriptionId: string; quoteId: string | null } | null>;
} = {
  quote: { data: null, isLoading: false },
  link: { data: null, isLoading: false },
};
const dialogProps = vi.fn();

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/quotes", () => ({ useQuoteByInvoiceId: () => state.quote }));
vi.mock("@/lib/queries/payments", () => ({
  usePaymentsByQuote: () => ({ data: [] }),
  totalReceived: () => 0,
  useInstalmentLink: () => state.link,
}));
vi.mock("@/components/features/quotes/record-payment-dialog", () => ({
  RecordPaymentDialog: (p: Record<string, unknown>) => {
    dialogProps(p);
    return <div data-testid="pay-sheet">sheet for {String(p.quoteId)}</div>;
  },
}));

import { RecordSubscriptionPaymentContainer } from "./record-invoice-payment";
import type { Invoice } from "@/lib/supabase/database.types";

const instalment = {
  id: "INV-ADPL-27-0042", customer_id: "c1", customer_name: "Sharma Traders",
  amount: 2360, net_payable: 2360, paid_amount: 0, status: "pending", quote_id: null,
} as unknown as Invoice;

beforeEach(() => {
  dialogProps.mockClear();
  state.quote = { data: null, isLoading: false };
  state.link = { data: null, isLoading: false };
});
afterEach(cleanup);

describe("Record payment on an instalment invoice (R-1564)", () => {
  it("opens the sheet for THIS instalment — not stuck on Loading payment…", () => {
    state.link = { data: { subscriptionId: "s1", quoteId: "Q-1" }, isLoading: false };
    render(<RecordSubscriptionPaymentContainer invoice={instalment} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/Loading payment/)).toBeNull();
    expect(screen.getByTestId("pay-sheet")).toBeTruthy();
    const p = dialogProps.mock.calls.at(-1)![0];
    expect(p.instalmentInvoiceId).toBe("INV-ADPL-27-0042");
    expect(p.invoiceId).toBe("INV-ADPL-27-0042");
    expect(p.quoteId).toBe("Q-1");
    // the instalment's own amount, never the year's quote total
    expect(p.expectedAmount).toBe(2360);
    expect(p.alreadyReceived).toBe(0);
    expect(p.askDomain).toBe(false);
  });

  it("a part-paid instalment opens with what is already in", () => {
    state.link = { data: { subscriptionId: "s1", quoteId: "Q-1" }, isLoading: false };
    render(<RecordSubscriptionPaymentContainer invoice={{ ...instalment, paid_amount: 1000 } as Invoice} open onOpenChange={() => {}} />);
    const p = dialogProps.mock.calls.at(-1)![0];
    expect(p.expectedAmount).toBe(2360);
    expect(p.alreadyReceived).toBe(1000);
  });

  it("a lookup that fails says so with Retry — never an endless Loading", () => {
    const refetchQuote = vi.fn();
    const refetchLink = vi.fn();
    state.quote = { data: null, isLoading: false, isError: true, error: new Error("network"), refetch: refetchQuote };
    state.link = { data: null, isLoading: false, isError: true, error: new Error("network"), refetch: refetchLink };
    render(<RecordSubscriptionPaymentContainer invoice={instalment} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/Loading payment/)).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(refetchQuote).toHaveBeenCalled();
    expect(refetchLink).toHaveBeenCalled();
  });

  it("an invoice with neither a quote nor an instalment link explains why — no hang", () => {
    render(<RecordSubscriptionPaymentContainer invoice={instalment} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/Loading payment/)).toBeNull();
    expect(screen.getByText(/not linked to a quote or a subscription instalment/i)).toBeTruthy();
  });

  it("an instalment whose subscription has no quote explains why", () => {
    state.link = { data: { subscriptionId: "s1", quoteId: null }, isLoading: false };
    render(<RecordSubscriptionPaymentContainer invoice={instalment} open onOpenChange={() => {}} />);
    expect(screen.getByText(/subscription was not sold through a quote/i)).toBeTruthy();
    expect(screen.queryByTestId("pay-sheet")).toBeNull();
  });

  it("still loading → the small hint, and the sheet is not opened with half the facts", () => {
    state.link = { data: null, isLoading: true };
    render(<RecordSubscriptionPaymentContainer invoice={instalment} open onOpenChange={() => {}} />);
    expect(screen.getByText(/Loading payment/)).toBeTruthy();
    expect(screen.queryByTestId("pay-sheet")).toBeNull();
  });

  it("a regular invoice with its own quote keeps the quote-keyed sheet", () => {
    state.quote = {
      data: { id: "Q-9", amount: 11800, customer_name: "X", lead_id: null, customer_id: "c1", is_one_off: true, domain: null },
      isLoading: false,
    };
    render(<RecordSubscriptionPaymentContainer invoice={{ ...instalment, quote_id: "Q-9", amount: 11800 } as Invoice} open onOpenChange={() => {}} />);
    const p = dialogProps.mock.calls.at(-1)![0];
    expect(p.quoteId).toBe("Q-9");
    expect(p.expectedAmount).toBe(11800);
    expect(p.instalmentInvoiceId ?? null).toBeNull();
  });
});
