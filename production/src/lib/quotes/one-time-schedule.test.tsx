// @vitest-environment jsdom
/* R-809 — a one-time charge has no billing schedule.

   Q-F588-27-0007 (add-seats, 1 seat pro-rata 25 Sep 2026 → 31 Aug 2027) is paid once, but its
   line still carries the seats' "annual_yearly" commitment. The public accept page, the quote
   PDF and the in-app preview all printed "Annual commit · billed yearly" off that commitment.
   Now each says "One-time charge" in the header and drops the schedule under the line. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));
vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null, Link: box,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { isOneTimeQuote, ONE_TIME_SCHEDULE } from "./service-period";
import { QuoteAcceptView, type PublicQuote, type PublicLine } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";

afterEach(cleanup);

const LINE = {
  id: "add-seats-1", name: "Starter · +1 seats (pro-rata from 2026-09-25 to 2027-08-31)",
  qty: 1, rate: 1900, cost: 1700, commitment: "annual_yearly" as const,
};
const amounts = { subtotal: 1900, discountPct: 0, discount: 0, taxable: 1900, taxRate: 18, tax: 342, total: 2242 };

describe("isOneTimeQuote", () => {
  it("add-seats and one-off are one-time; renewal / new / unknown are not", () => {
    expect(isOneTimeQuote({ isAddSeats: true })).toBe(true);
    expect(isOneTimeQuote({ isOneOff: true })).toBe(true);
    expect(isOneTimeQuote({ isAddSeats: false, isOneOff: false })).toBe(false);
    expect(isOneTimeQuote({ isAddSeats: null, isOneOff: null })).toBe(false);
    expect(isOneTimeQuote({})).toBe(false);
  });
});

describe("public accept page", () => {
  const pq = (over: Partial<PublicQuote> = {}): PublicQuote => ({
    id: "Q-F588-27-0007", status: "sent", customer_name: "Test Co", subtotal: 1900, discount_pct: 0,
    tax_rate: 18, amount: 2242, expires_date: null, notes: null, billing_cycle: "yearly",
    currency: "INR", exchange_rate: null, service_period: "covers 25 Sep 2026 to 31 Aug 2027", ...over,
  });
  const lines: PublicLine[] = [{ id: LINE.id, name: LINE.name, qty: 1, rate: 1900, commitment: "annual_yearly" }];
  const view = (q: PublicQuote) => render(
    <QuoteAcceptView quote={q} lineItems={lines} token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />,
  );

  it("one-time quote: 'One-time charge', never 'Annual commit' / 'billed yearly'", () => {
    view(pq({ one_time: true }));
    expect(screen.getByTestId("billing-schedule").textContent).toBe(ONE_TIME_SCHEDULE);
    expect(document.body.textContent).not.toMatch(/Annual commit|billed yearly/);
  });

  it("normal yearly quote keeps its schedule", () => {
    view(pq({ one_time: false, service_period: "covers 12 months" }));
    expect(screen.getByTestId("billing-schedule").textContent).toBe("Annual commit · billed yearly");
  });
});

describe("quote PDF", () => {
  const pdf = (oneTime?: boolean) => {
    const { container } = render(
      <QuotePDF tenantName="ANUTECH" quoteId="Q-F588-27-0007" customerName="Test Co" validityDays={7}
        interState={false} billingCycle="yearly" lineItems={[LINE]} {...amounts} oneTime={oneTime} />,
    );
    const t = container.textContent ?? "";
    cleanup();
    return t;
  };

  it("one-time quote: 'One-time charge', no yearly schedule or 'per year' on the line", () => {
    const t = pdf(true);
    expect(t).toContain(ONE_TIME_SCHEDULE);
    expect(t).not.toMatch(/Annual commit|billed yearly|per year/);
  });

  it("normal quote unchanged", () => {
    expect(pdf(false)).toContain("Annual commit, billed yearly");
    expect(pdf(undefined)).toContain("Annual commit, billed yearly");
  });
});

describe("in-app quote preview", () => {
  const preview = (oneTime: boolean) => {
    render(
      <QuotePreviewDialog
        open onOpenChange={() => {}} tenantName="ANUTECH" quoteId="Q-F588-27-0007" customerName="Test Co"
        lineItems={[LINE]} {...amounts} interState={false} billingCycle="yearly" validityDays={7} notes=""
        oneTime={oneTime}
      />,
    );
    const t = document.body.textContent ?? "";
    cleanup();
    return t;
  };

  it("one-time quote: 'One-time charge', no yearly schedule", () => {
    const t = preview(true);
    expect(t).toContain(ONE_TIME_SCHEDULE);
    expect(t).not.toMatch(/Annual commit|billed yearly/);
  });

  it("normal quote unchanged", () => {
    expect(preview(false)).toContain("Annual commit · billed yearly");
  });
});
