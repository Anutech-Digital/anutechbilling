// @vitest-environment jsdom
/* R-811 — a MONTH extension quote reads as what it is.

   Q-5F40-27-0011 (3-month extension, staging 10 Oct 2026) showed "Extension · 0 yr" and
   "Annual commitment · billed per year · ₹810/yr · ₹8,100/yr". Now its title comes from
   extension_months ("3-month extension"), it is a one-time charge with no "per year" / "/yr",
   and 1-year / 2-year extensions keep their yearly copy. Checked on the public accept page,
   the quote PDF and the in-app preview. */
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

import { extensionTitle, isOneTimeQuote, ONE_TIME_SCHEDULE } from "./service-period";
import { QuoteAcceptView, type PublicQuote, type PublicLine } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import { QuotePDF } from "@/lib/pdf/QuotePDF";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";

afterEach(cleanup);

const CASES = [
  { months: 3,  title: "3-month extension", oneTime: true },
  { months: 12, title: "1-year extension",  oneTime: false },
  { months: 24, title: "2-year extension",  oneTime: false },
] as const;

const flags = (m: number) => ({ isExtension: true, extensionMonths: m });
const lineFor = (title: string) => ({
  id: "extension-1", name: `Business Starter · ${title}`, qty: 10, rate: 810, cost: 672,
  commitment: "annual_yearly" as const,
});
const amounts = { subtotal: 8100, discountPct: 0, discount: 0, taxable: 8100, taxRate: 18, tax: 1458, total: 9558 };

describe("helpers per extension length", () => {
  it.each(CASES)("$months months → $title, one-time $oneTime", ({ months, title, oneTime }) => {
    expect(extensionTitle(flags(months))).toBe(title);
    expect(isOneTimeQuote(flags(months))).toBe(oneTime);
  });
});

describe("public accept page", () => {
  const view = (months: number, title: string) => {
    const q: PublicQuote = {
      id: "Q-5F40-27-0011", status: "sent", customer_name: "delfos", subtotal: 8100, discount_pct: 0,
      tax_rate: 18, amount: 9558, expires_date: null, notes: null, billing_cycle: "yearly",
      currency: "INR", exchange_rate: null, service_period: null,
      one_time: isOneTimeQuote(flags(months)), extension_title: extensionTitle(flags(months)),
    };
    const l = lineFor(title);
    const lines: PublicLine[] = [{ id: l.id, name: l.name, qty: l.qty, rate: l.rate, commitment: l.commitment }];
    render(<QuoteAcceptView quote={q} lineItems={lines} token="t" tenantName="ANUTECH" tenantGstin={null} tenantEmail={null} />);
  };

  it("3-month extension: title shown, one-time charge, nothing yearly", () => {
    view(3, "3-month extension");
    expect(screen.getByTestId("extension-title").textContent).toBe("3-month extension");
    expect(screen.getByTestId("billing-schedule").textContent).toBe(ONE_TIME_SCHEDULE);
    expect(document.body.textContent).not.toMatch(/Annual commit|billed yearly|per year|\/yr|0 yr/);
  });

  it.each([[12, "1-year extension"], [24, "2-year extension"]] as const)("%i months: title shown, yearly schedule kept", (m, title) => {
    view(m, title);
    expect(screen.getByTestId("extension-title").textContent).toBe(title);
    expect(screen.getByTestId("billing-schedule").textContent).toBe("Annual commit · billed yearly");
  });
});

describe("quote PDF", () => {
  const pdf = (months: number, title: string) => {
    const { container } = render(
      <QuotePDF tenantName="ANUTECH" quoteId="Q-5F40-27-0011" customerName="delfos" validityDays={7}
        interState={false} billingCycle="yearly" lineItems={[lineFor(title)]} {...amounts} isRenewal
        oneTime={isOneTimeQuote(flags(months))} extensionTitle={extensionTitle(flags(months))} />,
    );
    const t = container.textContent ?? "";
    cleanup();
    return t;
  };

  it("3-month extension: stamp names it, one-time, no 'per year'", () => {
    const t = pdf(3, "3-month extension");
    expect(t).toContain("3-MONTH EXTENSION");
    expect(t).toContain(ONE_TIME_SCHEDULE);
    expect(t).not.toMatch(/Annual commit|billed yearly|per year|\/yr/);
  });

  it.each([[12, "1-YEAR EXTENSION"], [24, "2-YEAR EXTENSION"]] as const)("%i months: stamp + yearly schedule kept", (m, stamp) => {
    const t = pdf(m, stamp.toLowerCase());
    expect(t).toContain(stamp);
    expect(t).toContain("Annual commit, billed yearly");
  });
});

describe("in-app quote preview", () => {
  const preview = (months: number, title: string) => {
    render(
      <QuotePreviewDialog
        open onOpenChange={() => {}} tenantName="ANUTECH" quoteId="Q-5F40-27-0011" customerName="delfos"
        lineItems={[lineFor(title)]} {...amounts} interState={false} billingCycle="yearly" validityDays={7} notes=""
        oneTime={isOneTimeQuote(flags(months))} extensionTitle={extensionTitle(flags(months))}
      />,
    );
    const t = document.body.textContent ?? "";
    cleanup();
    return t;
  };

  it("3-month extension: title, one-time, no yearly copy", () => {
    const t = preview(3, "3-month extension");
    expect(t).toContain("3-month extension");
    expect(t).toContain(ONE_TIME_SCHEDULE);
    expect(t).not.toMatch(/Annual commit|billed yearly|per year|\/yr/);
  });

  it.each([[12, "1-year extension"], [24, "2-year extension"]] as const)("%i months: title + yearly schedule kept", (m, title) => {
    const t = preview(m, title);
    expect(t).toContain(title);
    expect(t).toContain("Annual commit · billed yearly");
  });
});
