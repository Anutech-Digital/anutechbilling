// @vitest-environment jsdom
/* R-495 (Pardeep, 9 Oct 2026 — decision 1A): the quote PDF, the in-app preview and the
   customer's quote link all print, per line, list price, discount (₹ and %) and the final
   rate — from one builder (lib/quotes/line-price-breakdown). Total unchanged. A line with
   no discount (or no list price) shows only the final rate. Each surface is rendered for
   real (@react-pdf primitives mocked, as in quote-support-line.test.tsx). */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip, Page: box, View: box, Text: text, Image: () => null,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import { QuotePDF } from "./QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { QuoteAcceptView, type PublicLine } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

// 10 seats, list ₹2,400/seat/yr, sold at ₹2,100 → ₹300 off (12.5%). Hosting: no discount.
const discounted = { id: "l1", name: "Google Workspace Business Starter", qty: 10, rate: 2100, list_rate: 2400, cost: 1500, commitment: "annual_yearly" };
const plain      = { id: "l2", name: "Web Hosting Basic", qty: 1, rate: 3000, list_rate: 3000, cost: 1000, commitment: "annual_yearly" };
const noList     = { id: "l3", name: "Custom setup", qty: 1, rate: 5000, cost: 0, commitment: "annual_yearly" };
const items = [discounted, plain, noList] as unknown as QuoteLineItem[];

// subtotal = 21,000 + 3,000 + 5,000 = 29,000 (the rates — unchanged by R-495)
const amounts = { subtotal: 29000, discountPct: 0, discount: 0, taxable: 29000, taxRate: 18, tax: 5220, total: 34220 };

const DISC = /List ₹\s?2,400 · Discount ₹\s?300 \(12\.5%\) · Final ₹\s?2,100/;

function pdfText(): string {
  const { container } = render(
    <QuotePDF tenantName="ANUTECH" quoteId="Q-R495" customerName="Test Co" validityDays={7}
      interState={false} billingCycle="yearly" lineItems={items} {...amounts} />,
  );
  return (container.textContent ?? "").replace(/Rs\.?\s?/g, "₹");
}

function previewText(): string {
  render(
    <QuotePreviewDialog open onOpenChange={() => {}} tenantName="ANUTECH" quoteId="Q-R495" customerName="Test Co"
      interState={false} billingCycle="yearly" validityDays={7} notes="" lineItems={items} {...amounts} />,
  );
  return document.body.textContent ?? "";
}

function linkText(): string {
  const lines: PublicLine[] = [
    { id: "l1", name: discounted.name, qty: 10, rate: 2100, list_rate: 2400, commitment: "annual_yearly" },
    { id: "l2", name: plain.name, qty: 1, rate: 3000, list_rate: 3000, commitment: "annual_yearly" },
    { id: "l3", name: noList.name, qty: 1, rate: 5000, commitment: "annual_yearly" },
  ];
  render(
    <QuoteAcceptView
      quote={{ id: "Q-R495", status: "sent", customer_name: "Test Co", subtotal: 29000, discount_pct: 0, tax_rate: 18,
        amount: 34220, expires_date: null, notes: null, billing_cycle: "yearly", currency: "INR", exchange_rate: null }}
      lineItems={lines} token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />,
  );
  return document.body.textContent ?? "";
}

describe.each([
  ["quote PDF", pdfText],
  ["in-app preview", previewText],
  ["customer quote link", linkText],
])("%s", (_label, read) => {
  it("discounted line: list, ₹ + % discount, final", () => {
    expect(read()).toMatch(DISC);
  });
  it("only the discounted line gets a breakdown (0 discount / no list → final only)", () => {
    const t = read();
    // Every "List ₹" printed is the discounted line's (the link renders it twice: phone card + desktop table).
    expect(t.match(/List ₹/g)?.length).toBe(t.match(new RegExp(DISC.source, "g"))?.length);
    expect(t).not.toMatch(/List ₹\s?3,000/);
    expect(t).not.toMatch(/List ₹\s?5,000/);
  });
  it("total unchanged", () => {
    expect(read()).toMatch(/34,220/);
  });
});
