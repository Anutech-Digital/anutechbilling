// @vitest-environment jsdom
/* R-2746 (owner, 10 Nov): a renewal quote says WHICH period it buys, just above its lines —
   "Renewal · 27 Oct 2026 – 26 Oct 2027" — on the preview (quote page, quotes list, builder), the
   quote PDF and the customer accept page. Same dates as each line's "Subscription period" (R-1764 /
   R-2727). A new-sale quote shows no such label. @react-pdf primitives are mocked so the PDF
   renders as text (as in line-period-surfaces.test). */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children} </span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null, Link: box,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { buildQuotePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { QuoteAcceptView } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import { quoteLinePeriodContext } from "./service-period";
import { renewalPeriodLabel } from "./renewal-period-label";
import type { Quote, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const LABEL = "Renewal · 27 Oct 2026 – 26 Oct 2027";
const PERIOD = "Subscription period: 1 Year (27/10/2026 – 26/10/2027)";

const starter = { id: "renewal-1", name: "Google Workspace - Business Starter", qty: 7, rate: 3099, cost: 2000, commitment: "annual_yearly" };
const lines = [starter] as unknown as QuoteLineItem[];
const quote = {
  id: "Q-DI-0001", tenant_id: "t1", customer_name: "Dynamic Industries", status: "sent",
  subtotal: 21693, discount_pct: 0, tax_rate: 18, amount: 25598, line_items: lines,
  created_date: "2026-10-22", expires_date: "2026-11-05", notes: null, billing_cycle: "yearly",
  is_renewal: true, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: 12,
  renewal_term_date: "2026-10-26", renewal_subscription_id: "sub-1", domain: null,
} as unknown as Quote;
const newSale = { ...quote, id: "Q-NEW-1", is_renewal: false, extension_months: null, renewal_term_date: null } as unknown as Quote;

const tenant: TenantPdfInfo = {
  name: "Anutech", gstin: null, email: null, phone: null, address: null, state: null, state_code: "06",
  logo_url: null, upi_vpa: null, remit_bank_name: null, remit_account_name: null,
  remit_account_number: null, remit_ifsc: null, remit_branch: null,
};

function preview(ctx: ReturnType<typeof quoteLinePeriodContext>) {
  return render(
    <QuotePreviewDialog open onOpenChange={() => {}} tenantName="ANUTECH" quoteId={quote.id} customerName="Dynamic Industries"
      interState={false} billingCycle="yearly" validityDays={14} notes="" lineItems={lines}
      subtotal={21693} discountPct={0} discount={0} taxable={21693} taxRate={18} tax={3905} total={25598}
      periodContext={ctx} />,
  );
}

describe("R-2746 — 'Renewal · <from> – <to>' above the lines on every surface", () => {
  it("preview (quote page / quotes list / builder): the label, once, with the line's own dates", () => {
    preview(quoteLinePeriodContext(quote, "dynamicindustries.in"));
    expect(screen.getByTestId("renewal-period-label").textContent).toBe(LABEL);
    expect(document.body.textContent).toContain(PERIOD);
  });

  it("preview of a new-sale quote: no label", () => {
    preview(quoteLinePeriodContext(newSale, null));
    expect(screen.queryByTestId("renewal-period-label")).toBeNull();
  });

  it("quote PDF: the label, before the line table", () => {
    const { container } = render(<QuotePDF {...buildQuotePdfProps({ quote, customer: null, tenant, subscriptionDomain: "dynamicindustries.in" })} />);
    const text = container.textContent ?? "";
    expect(text).toContain(LABEL);
    expect(text.indexOf(LABEL)).toBeLessThan(text.indexOf("Description"));
  });

  it("quote PDF of a new sale: no label", () => {
    const { container } = render(<QuotePDF {...buildQuotePdfProps({ quote: newSale, customer: null, tenant })} />);
    expect(container.textContent).not.toMatch(/Renewal ·|Extension ·/);
  });

  it("customer accept page: the label the server built, in plain English", () => {
    const label = renewalPeriodLabel(lines, quoteLinePeriodContext(quote, null))?.text ?? null;
    expect(label).toBe(LABEL);
    render(
      <QuoteAcceptView
        quote={{ id: quote.id, status: "sent", customer_name: "Dynamic Industries", subtotal: 21693, discount_pct: 0, tax_rate: 18,
          amount: 25598, expires_date: null, notes: null, billing_cycle: "yearly", currency: "INR", exchange_rate: null,
          renewal_period_label: label }}
        lineItems={[{ id: starter.id, name: starter.name, qty: 7, rate: 3099, commitment: "annual_yearly" }]}
        token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />,
    );
    expect(screen.getByTestId("renewal-period-label").textContent).toBe(LABEL);
  });
});
