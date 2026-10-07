// @vitest-environment jsdom
/* R-045 slice 3 — a USD invoice prints the rate it was ISSUED at, with source and date, and its
   taxable value / GST in ₹. Old invoices (no fx columns) keep the quote fallback.
   The PDF tree is rendered with @react-pdf primitives mocked to div/span (as in
   quote-gst-heads.test.tsx), so we read what is actually printed. No network. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return {
    Document: strip,
    Page: box,
    View: box,
    Text: text,
    Image: () => null,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { InvoicePDF, type InvoicePDFProps } from "@/lib/pdf/InvoicePDF";
import { QuotePDF, type QuotePDFProps } from "@/lib/pdf/QuotePDF";
import { buildInvoicePdfProps, buildQuotePdfProps, invoiceFx, type TenantPdfInfo } from "@/lib/pdf/build-props";
import type { Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const tenant: TenantPdfInfo = {
  name: "ANUTECH DIGITAL PVT LTD", gstin: "07ABDCA0298H1ZP", email: null, phone: null,
  address: "Delhi", state: "Delhi", state_code: "07",
} as TenantPdfInfo;

const lines = [{ id: "l1", name: "Google Workspace Business Starter", qty: 1, rate: 9598, cost: 9000, commitment: "annual_yearly" }] as unknown as QuoteLineItem[];

const baseInvoice = {
  id: "INV-ADPL-2026-27-0001", tenant_id: "t", customer_id: null, customer_name: "US Client",
  amount: 9598, taxable_value: 9598, tax_amount: 0, tax_rate: 0, inter_state: true,
  invoice_date: "2026-10-07", due_date: null, paid_date: null, adjusted_advances: [], net_payable: null,
  quote_id: "Q-1", line_items: lines, paid_amount: 0, status: "pending",
  currency: null, fx_rate: null, fx_source: null, fx_date: null,
} as unknown as Invoice;

const quote = {
  id: "Q-1", tenant_id: "t", customer_name: "US Client", line_items: lines, subtotal: 9598, discount_pct: 0,
  tax_rate: 0, amount: 9598, currency: "USD", exchange_rate: 99.5, fx_source: "manual", fx_date: "2026-10-07",
  billing_cycle: "yearly", created_date: "2026-10-01", expires_date: "2026-10-31",
} as unknown as Quote;

const issued = { ...baseInvoice, currency: "USD", fx_rate: 95.9832, fx_source: "fbil", fx_date: "2026-09-30" } as unknown as Invoice;

describe("invoiceFx — the rate frozen on the invoice wins", () => {
  it("issued since R-045: invoice's own currency/rate/source/date, even if the quote was re-rated", () => {
    expect(invoiceFx(issued, quote)).toEqual({ currency: "USD", exchangeRate: 95.9832, fxSource: "fbil", fxDate: "2026-09-30" });
  });
  it("older invoice: falls back to the quote's currency/rate, no source/date claimed", () => {
    expect(invoiceFx(baseInvoice, quote)).toEqual({ currency: "USD", exchangeRate: 99.5, fxSource: null, fxDate: null });
  });
  it("INR invoice, INR quote: nothing foreign", () => {
    expect(invoiceFx(baseInvoice, { currency: "INR", exchange_rate: 1 }).currency).toBe("INR");
    expect(invoiceFx(baseInvoice, null)).toEqual({ currency: null, exchangeRate: null, fxSource: null, fxDate: null });
  });
  it("buildInvoicePdfProps carries them", () => {
    const p = buildInvoicePdfProps({ invoice: issued, quote, customer: null, tenant });
    expect(p).toMatchObject({ currency: "USD", exchangeRate: 95.9832, fxSource: "fbil", fxDate: "2026-09-30" });
  });
  it("buildQuotePdfProps carries the quote's stamp", () => {
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p).toMatchObject({ currency: "USD", exchangeRate: 99.5, fxSource: "manual", fxDate: "2026-10-07" });
  });
});

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("invoice PDF prints the ₹ equivalent line", () => {
  function invoiceText(props: Partial<InvoicePDFProps>): string {
    const p = { ...buildInvoicePdfProps({ invoice: issued, quote, customer: null, tenant }), ...props } as InvoicePDFProps;
    const { container } = render(<>{InvoicePDF(p)}</>);
    return norm(container.textContent);
  }

  it("USD invoice: rate + FBIL source + date, and taxable value / total in ₹", () => {
    const t = invoiceText({});
    expect(t).toMatch(/(₹|Rs) ?equivalent at 1 USD = (₹|Rs ?)95\.9832 \(FBIL\/RBI reference rate, 30 Sep 2026\)/);
    expect(t).toMatch(/Taxable value \(INR\)\s*(₹|Rs ?)9,598/);
    expect(t).toMatch(/Invoice total \(INR, for GST\)\s*(₹|Rs ?)9,598/);
    expect(t).not.toMatch(/GST \(INR\)/); // zero-rated export: no GST row
  });

  it("GST, when charged, is shown in ₹", () => {
    const t = invoiceText({ taxable: 9598, tax: 1728, total: 11326, taxRate: 18 });
    expect(t).toMatch(/GST \(INR\)\s*(₹|Rs ?)1,728/);
  });

  it("indicative source is labelled as such", () => {
    expect(invoiceText({ fxSource: "er-api", fxDate: "2026-10-06" })).toMatch(/indicative market rate, 6 Oct 2026/);
  });

  it("old invoice (no stamp): just the rate, no invented source/date", () => {
    const p = buildInvoicePdfProps({ invoice: baseInvoice, quote, customer: null, tenant });
    const { container } = render(<>{InvoicePDF(p)}</>);
    const t = norm(container.textContent);
    expect(t).toMatch(/equivalent at 1 USD = (₹|Rs ?)99\.5(?! \()/);
  });

  it("INR invoice: no equivalent line", () => {
    const t = invoiceText({ currency: null, exchangeRate: null, fxSource: null, fxDate: null });
    expect(t).not.toMatch(/equivalent at 1/);
  });
});

describe("quote PDF uses the same line", () => {
  it("prints source + date", () => {
    const p = buildQuotePdfProps({ quote: { ...quote, fx_source: "fbil", fx_date: "2026-09-30", exchange_rate: 95.9832 } as Quote, customer: null, tenant }) as QuotePDFProps;
    const { container } = render(<>{QuotePDF(p)}</>);
    expect(norm(container.textContent)).toMatch(/equivalent at 1 USD = (₹|Rs ?)95\.9832 \(FBIL\/RBI reference rate, 30 Sep 2026\)/);
  });
});
