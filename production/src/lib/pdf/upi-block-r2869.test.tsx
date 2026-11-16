// @vitest-environment jsdom
/* R-2869 — a part payment request (part proforma) is a "Payment for <period>", never an advance:
   its UPI block says "Scan to pay" and that the tax invoice is raised when the payment is received.
   An ordinary quote keeps the deliberate advance / receipt-voucher wording (CGST §31(3)(d)).
   PDF, in-app preview and the helper say the same words (R-1694). */
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
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { QuotePDF } from "./QuotePDF";
import { buildQuotePdfProps, type TenantPdfInfo } from "./build-props";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { upiBlockWords } from "@/lib/billing/proforma";
import type { Quote } from "@/lib/supabase/database.types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tenant: TenantPdfInfo = {
  name: "Anutech", gstin: null, email: null, phone: null, address: null, state: null, state_code: "06",
  logo_url: null, upi_vpa: "a@b", remit_bank_name: null, remit_account_name: null,
  remit_account_number: null, remit_ifsc: null, remit_branch: null,
};
const base = {
  id: "Q-1", tenant_id: "t1", customer_name: "Test Co", status: "sent", subtotal: 1000, discount_pct: 0,
  tax_rate: 18, amount: 1180, line_items: [], created_date: "2026-11-01", expires_date: "2026-11-15",
  notes: null, billing_cycle: "yearly",
};
const partQuote = { ...base, subscription_billing_id: "b-1" } as unknown as Quote;
const plainQuote = { ...base, subscription_billing_id: null } as unknown as Quote;

function pdfText(q: Quote): string {
  const props = { ...buildQuotePdfProps({ quote: q, customer: null, tenant }), upiQrDataUrl: "data:image/png;base64,QR", upiVpa: "a@b" };
  const { container } = render(<QuotePDF {...props} />);
  return container.textContent ?? "";
}

describe("upiBlockWords (R-2869)", () => {
  it("part request: Scan to pay, tax invoice on receipt, no advance / receipt voucher", () => {
    const w = upiBlockWords({ partRequest: true, billOfSupply: false });
    expect(w.title).toBe("Scan to pay");
    expect(w.note).toContain("GST tax invoice is raised when the payment is received");
    expect(`${w.title} ${w.note}`).not.toMatch(/advance|receipt voucher/i);
    expect(upiBlockWords({ partRequest: true, billOfSupply: true }).note).toContain("Bill of Supply is raised");
  });
  it("ordinary quote keeps today's words", () => {
    const w = upiBlockWords({ partRequest: false, billOfSupply: false });
    expect(w.title).toBe("Scan to pay this advance");
    expect(w.note).toContain("receipt voucher, and a GST tax invoice when the order is provisioned");
  });
});

describe("PDF UPI block (R-2869)", () => {
  it("part proforma says Scan to pay, never advance", () => {
    const t = pdfText(partQuote);
    expect(t).toContain("Scan to pay");
    expect(t).toContain("tax invoice is raised when the payment is received");
    expect(t).not.toContain("this advance");
    expect(t).not.toMatch(/receipt\s+voucher/);
  });
  it("ordinary quote keeps the advance wording", () => {
    const t = pdfText(plainQuote);
    expect(t).toContain("Scan to pay this advance");
    expect(t).toMatch(/receipt\s+voucher/);
  });
});

describe("preview UPI block (R-2869)", () => {
  function preview(partRequest: boolean) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ qr: { dataUrl: "data:image/png;base64,QR", vpa: "a@b", amount: 1180 } }), { status: 200 })));
    render(
      <QuotePreviewDialog open onOpenChange={() => {}} tenantName="ANUTECH" quoteId="Q-1" customerName="Test Co"
        lineItems={[]} subtotal={1000} discountPct={0} discount={0} taxable={1000} taxRate={18} tax={180} total={1180}
        interState={false} billingCycle="yearly" validityDays={7} notes="" upiVpa="a@b" payQrQuoteId="Q-1" partRequest={partRequest} />,
    );
  }
  it("part request → Scan to pay + tax invoice line", async () => {
    preview(true);
    const block = await screen.findByTestId("preview-upi-block");
    expect(block.textContent).toContain("Scan to pay");
    expect(block.textContent).toContain("tax invoice is raised when the payment is received");
    expect(block.textContent).not.toContain("advance");
  });
  it("ordinary quote → unchanged", async () => {
    preview(false);
    const block = await screen.findByTestId("preview-upi-block");
    expect(block.textContent).toContain("Scan to pay this advance");
  });
});
