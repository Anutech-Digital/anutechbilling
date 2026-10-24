// @vitest-environment jsdom
/* R-1742 — an invoice to an SEZ unit carries the Rule 46 SEZ endorsement. Owner's example:
   SEZ (with payment), ₹38,232 = ₹32,400 + IGST ₹5,832, SEZ unit and seller both in Delhi.
   Rendered with @react-pdf primitives mocked to div/span (as in bill-of-supply-pdf.test.tsx). */
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

import { InvoicePDF, type InvoicePDFProps } from "@/lib/pdf/InvoicePDF";
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import type { Customer, Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";
import { SEZ_WITH_PAYMENT_ENDORSEMENT, SEZ_WITHOUT_PAYMENT_ENDORSEMENT } from "@/lib/gst/sez-endorsement";
import { EXPORT_LUT_ENDORSEMENT } from "@/lib/gst/export-lut";

afterEach(cleanup);

const lines = [{ id: "l1", name: "Google Workspace Business Standard", qty: 20, rate: 1620, hsn: "998313" }] as unknown as QuoteLineItem[];
const quote = {
  id: "Q-1", tenant_id: "t", customer_name: "SEZ Unit Pvt Ltd", line_items: lines, subtotal: 32400, discount_pct: 0,
  tax_rate: 18, amount: 38232, currency: "INR", exchange_rate: 1, billing_cycle: "annual",
  created_date: "2026-10-01", expires_date: "2026-10-31",
} as unknown as Quote;
const tenant = {
  name: "ANUTECH DIGITAL PVT LTD", gstin: "07ABDCA0298H1ZP", email: null, phone: null,
  address: "New Delhi", state: "Delhi", state_code: "07", lut_number: "AD0710250000001",
} as TenantPdfInfo;
const customer = {
  id: "c1", name: "SEZ Unit Pvt Ltd", gstin: "07AAACS1234E1ZP", state_code: "07", state: "Delhi", country: "India",
  gst_treatment: "sez_with_payment",
} as unknown as Customer;
const sezInvoice = {
  id: "INV-2026-0042", tenant_id: "t", customer_id: "c1", customer_name: "SEZ Unit Pvt Ltd",
  amount: 38232, taxable_value: 32400, tax_amount: 5832, tax_rate: 18, inter_state: true,
  invoice_date: "2026-10-22", due_date: "2026-11-21", paid_date: null, adjusted_advances: [], net_payable: null,
  quote_id: "Q-1", line_items: lines, paid_amount: 0, status: "pending",
  currency: null, fx_rate: null, fx_source: null, fx_date: null,
  document_kind: "tax_invoice", customer_gstin: "07AAACS1234E1ZP", pos_state_code: "07", customer_country: "India",
  gst_treatment: "sez_with_payment",
} as unknown as Invoice;

function printed(invoice: Invoice, c: Customer = customer): string {
  const p = buildInvoicePdfProps({ invoice, quote, customer: c, tenant }) as InvoicePDFProps;
  const { container } = render(<>{InvoicePDF(p)}</>);
  return container.textContent ?? "";
}

describe("R-1742 SEZ endorsement on the invoice PDF", () => {
  it("SEZ with payment (₹38,232, IGST ₹5,832): prints the with-payment line and IGST, no LUT ARN", () => {
    const text = printed(sezInvoice);
    expect(text).toContain(SEZ_WITH_PAYMENT_ENDORSEMENT);
    expect(text).toMatch(/IGST/);
    expect(text).not.toContain("LUT ARN");
    expect(text).not.toContain(EXPORT_LUT_ENDORSEMENT);
  });

  it("SEZ with no tax charged: prints the without-payment line with the LUT ARN", () => {
    const text = printed({ ...sezInvoice, gst_treatment: "sez_without_payment", amount: 32400, tax_amount: 0, tax_rate: 0 } as Invoice,
      { ...customer, gst_treatment: "sez_without_payment" } as Customer);
    expect(text).toContain(SEZ_WITHOUT_PAYMENT_ENDORSEMENT);
    expect(text).toContain("LUT ARN: AD0710250000001");
  });

  it("an ordinary registered customer's invoice prints no SEZ line", () => {
    const text = printed({ ...sezInvoice, gst_treatment: "registered_regular" } as Invoice, { ...customer, gst_treatment: "registered_regular" } as Customer);
    expect(text).not.toContain("SEZ UNIT");
  });
});
