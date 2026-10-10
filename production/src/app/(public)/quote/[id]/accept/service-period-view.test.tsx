// @vitest-environment jsdom
/** R-806 — the public accept page shows the real period, never a blanket "12 months". */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import { QuoteAcceptView, type PublicQuote, type PublicLine } from "./quote-accept-view";

afterEach(cleanup);

const pq = (over: Partial<PublicQuote> = {}): PublicQuote => ({
  id: "Q-F588-27-0007", status: "sent", customer_name: "Test Co", subtotal: 1900, discount_pct: 0,
  tax_rate: 18, amount: 2242, expires_date: null, notes: null, billing_cycle: "yearly",
  currency: "INR", exchange_rate: null, ...over,
});
const lines: PublicLine[] = [{
  id: "add-seats-1", name: "Starter · +1 seats (pro-rata from 2026-09-25 to 2027-08-31)",
  qty: 1, rate: 1900, commitment: "annual_yearly",
}];

const view = (quote: PublicQuote) => render(
  <QuoteAcceptView quote={quote} lineItems={lines} token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />,
);

describe("accept page period line (R-806)", () => {
  it("pro-rata quote shows its dates, not 12 months", () => {
    view(pq({ service_period: "covers 25 Sep 2026 to 31 Aug 2027" }));
    expect(screen.getByTestId("service-period").textContent).toBe("✓ One-time payment · covers 25 Sep 2026 to 31 Aug 2027");
    expect(document.body.textContent).not.toMatch(/12 months/);
  });
  it("yearly quote says 12 months", () => {
    view(pq({ service_period: "covers 12 months" }));
    expect(screen.getByTestId("service-period").textContent).toMatch(/covers 12 months$/);
  });
  it("unknown period → no claim at all", () => {
    view(pq({ service_period: null }));
    expect(screen.getByTestId("service-period").textContent).toBe("✓ One-time payment");
    expect(document.body.textContent).not.toMatch(/covers/);
  });
});
