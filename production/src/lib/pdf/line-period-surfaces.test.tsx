// @vitest-environment jsdom
/* R-1764 (Pardeep, 22 Oct — renewal quote preview, Dynamic Industries, Business Starter 7 × ₹3,099:
   "ye renewal quote hai aur product ke description me subscription period show nahi ho raha").
   Every surface the customer reads — the in-app preview, the quote PDF, the accept page, the
   quote email and the tax invoice raised from the quote — prints, under each subscription
   line, the domain and the NEXT term; a one-time line (Support Charges) prints neither.
   @react-pdf primitives are mocked so the PDFs render as text (as in quote-line-discount.test). */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

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

import { QuotePDF } from "./QuotePDF";
import { InvoicePDF } from "./InvoicePDF";
import { buildQuotePdfProps, buildInvoicePdfProps, type TenantPdfInfo } from "./build-props";
import { lineDetailNotes } from "./invoice-display";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { QuoteAcceptView, type PublicLine } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import { buildCustomerQuoteHtml } from "@/lib/email/quote-template";
import { quoteLinePeriodContext } from "@/lib/quotes/service-period";
import { loadQuotePeriodContext, loadRenewedSubscriptionDomain } from "@/lib/quotes/line-period-context";
import type { Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const PERIOD = "Subscription period: 1 Year (27/10/2026 – 26/10/2027)";
const DOMAIN = "Domain: dynamicindustries.in";

const starter = { id: "renewal-1", name: "Google Workspace - Business Starter ( Email Solutions )", qty: 7, rate: 3099, cost: 2000, commitment: "annual_yearly" };
const support = { id: "s1", name: "Support Charges", qty: 1, rate: 1000, cost: 0, one_time: true };
const lines = [starter, support] as unknown as QuoteLineItem[];

// The renewal quote create_renewal_quote made: no domain on it, renewal_term_date = the
// subscription's renewal date (26 Oct 2026), 12 months.
const quote = {
  id: "Q-DI-0001", tenant_id: "t1", customer_name: "Dynamic Industries", status: "sent",
  subtotal: 22693, discount_pct: 0, tax_rate: 18, amount: 26778, line_items: lines,
  created_date: "2026-10-22", expires_date: "2026-11-05", notes: null, billing_cycle: "yearly",
  is_renewal: true, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: 12,
  renewal_term_date: "2026-10-26", renewal_subscription_id: "sub-1", domain: null,
} as unknown as Quote;

const tenant: TenantPdfInfo = {
  name: "Anutech", gstin: null, email: null, phone: null, address: null, state: null, state_code: "06",
  logo_url: null, upi_vpa: null, remit_bank_name: null, remit_account_name: null,
  remit_account_number: null, remit_ifsc: null, remit_branch: null,
};

const ctx = quoteLinePeriodContext(quote, "dynamicindustries.in");

/** The text of the Starter line's block and of the Support line's block, by name. */
function expectOnlyOnStarter(text: string) {
  expect(text).toContain(DOMAIN);
  expect(text).toContain(PERIOD);
  // Said once each — not repeated for the one-time line.
  expect(text.split("Subscription period:").length - 1).toBe(1);
  expect(text.split("Domain:").length - 1).toBe(1);
  expect(text).not.toContain("For dynamicindustries.in");
}

describe("R-1764 — every surface prints the renewal's next term under the subscription line", () => {
  it("in-app preview", () => {
    render(
      <QuotePreviewDialog open onOpenChange={() => {}} tenantName="ANUTECH" quoteId={quote.id} customerName="Dynamic Industries"
        interState={false} billingCycle="yearly" validityDays={14} notes="" lineItems={lines}
        subtotal={22693} discountPct={0} discount={0} taxable={22693} taxRate={18} tax={4085} total={26778}
        periodContext={ctx} />,
    );
    expectOnlyOnStarter(document.body.textContent ?? "");
  });

  it("quote PDF (the download / email attachment builder)", () => {
    const props = buildQuotePdfProps({ quote, customer: null, tenant, subscriptionDomain: "dynamicindustries.in" });
    const { container } = render(<QuotePDF {...props} />);
    expectOnlyOnStarter(container.textContent ?? "");
  });

  it("public accept page", () => {
    const pub: PublicLine[] = lines.map((l) => ({
      id: l.id, name: l.name, qty: l.qty, rate: l.rate, commitment: l.commitment,
      detail_notes: lineDetailNotes(l, ctx),
    }));
    render(
      <QuoteAcceptView
        quote={{ id: quote.id, status: "sent", customer_name: "Dynamic Industries", subtotal: 22693, discount_pct: 0, tax_rate: 18,
          amount: 26778, expires_date: null, notes: null, billing_cycle: "yearly", currency: "INR", exchange_rate: null }}
        lineItems={pub} token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />,
    );
    // The page renders the table and the phone list; each says it once per layout.
    const text = document.body.textContent ?? "";
    expect(text).toContain(DOMAIN);
    expect(text).toContain(PERIOD);
  });

  it("quote email", () => {
    const html = buildCustomerQuoteHtml({
      quoteId: quote.id, customerName: "Dynamic Industries", tenantName: "Anutech", totalAmount: 26778,
      acceptUrl: "https://x/q", lineItems: lines.map((l) => ({ name: l.name, qty: l.qty, rate: l.rate, notes: lineDetailNotes(l, ctx) })),
    });
    expectOnlyOnStarter(html);
  });

  it("tax invoice raised from the quote says the same words", () => {
    const invoice = { id: "INV-1", tenant_id: "t1", customer_name: "Dynamic Industries", amount: 26778,
      invoice_date: "2026-10-27", status: "unpaid" } as unknown as Invoice;
    const props = buildInvoicePdfProps({ invoice, quote, customer: null, tenant, subscriptionDomain: "dynamicindustries.in" });
    const { container } = render(<InvoicePDF {...props} />);
    expectOnlyOnStarter(container.textContent ?? "");
  });

  it("an instalment / quote-less invoice says no period (it covers only a part)", () => {
    const invoice = { id: "INV-2", tenant_id: "t1", customer_name: "X", amount: 2360, taxable_value: 2000,
      tax_amount: 360, tax_rate: 18, line_items: [starter] } as unknown as Invoice;
    expect(buildInvoicePdfProps({ invoice, quote: null, customer: null, tenant }).periodContext).toBeNull();
  });
});

describe("R-1764 — the renewal quote's domain comes from the subscription it renews", () => {
  function fakeDb(row: { domain: string | null } | null) {
    const calls: Array<[string, unknown]> = [];
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => { calls.push([c, v]); return chain; },
      limit: () => chain,
      maybeSingle: async () => ({ data: row, error: null }),
    };
    return { db: { from: () => chain }, calls };
  }

  it("reads it by renewal_subscription_id, tenant-scoped", async () => {
    const { db, calls } = fakeDb({ domain: "dynamicindustries.in" });
    const c = await loadQuotePeriodContext(db, quote as never);
    expect(c.domain).toBe("dynamicindustries.in");
    expect(calls).toEqual([["tenant_id", "t1"], ["id", "sub-1"]]);
  });

  it("a quote with its own domain, or a new sale, reads nothing", async () => {
    const { db, calls } = fakeDb({ domain: "other.in" });
    expect(await loadRenewedSubscriptionDomain(db, { ...(quote as never as object), domain: "own.in" } as never)).toBeNull();
    expect(await loadRenewedSubscriptionDomain(db, { ...(quote as never as object), is_renewal: false } as never)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a failed read drops only the Domain line", async () => {
    const db = { from: () => { throw new Error("down"); } };
    const c = await loadQuotePeriodContext(db, quote as never);
    expect(c.domain).toBeNull();
    expect(lineDetailNotes(starter as unknown as QuoteLineItem, c)).toEqual([PERIOD]);
  });
});
