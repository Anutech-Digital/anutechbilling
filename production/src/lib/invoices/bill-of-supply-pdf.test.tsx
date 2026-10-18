// @vitest-environment jsdom
/* R-1529 — a Bill of Supply prints as one (CGST Rule 49), a Tax Invoice is unchanged.
   The PDF tree is rendered with @react-pdf primitives mocked to div/span (as in
   invoice-fx-pdf.test.tsx), so we read what is actually printed. */
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
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import type { Invoice, Quote, QuoteLineItem } from "@/lib/supabase/database.types";
import { COMPOSITION_DECLARATION, UNREGISTERED_DECLARATION } from "./document-kind";

afterEach(cleanup);

const lines = [{ id: "l1", name: "Website setup", description: "Five-page site", qty: 1, rate: 10000, hsn: "998314" }] as unknown as QuoteLineItem[];

const quote = {
  id: "Q-1", tenant_id: "t", customer_name: "Sharma Traders", line_items: lines, subtotal: 10000, discount_pct: 0,
  tax_rate: 0, amount: 10000, currency: "INR", exchange_rate: 1, billing_cycle: "one_time",
  created_date: "2026-10-01", expires_date: "2026-10-31",
} as unknown as Quote;

const unregTenant = {
  name: "Gupta Web Studio", gstin: null, email: null, phone: null,
  address: "12 MG Road, New Delhi", state: "Delhi", state_code: "07",
} as TenantPdfInfo;

const bos = {
  id: "BOS-GWS1-27-0001", tenant_id: "t", customer_id: null, customer_name: "Sharma Traders",
  amount: 10000, taxable_value: 10000, tax_amount: 0, tax_rate: 0, inter_state: false,
  invoice_date: "2026-10-18", due_date: "2026-11-17", paid_date: null, adjusted_advances: [], net_payable: null,
  quote_id: "Q-1", line_items: lines, paid_amount: 0, status: "pending",
  currency: null, fx_rate: null, fx_source: null, fx_date: null,
  document_kind: "bill_of_supply", supplier_gst_status: "unregistered", pos_state_code: "29",
} as unknown as Invoice;

function printed(invoice: Invoice, tenant: TenantPdfInfo, q: Quote = quote): string {
  const p = buildInvoicePdfProps({ invoice, quote: q, customer: null, tenant }) as InvoicePDFProps;
  const { container } = render(<>{InvoicePDF(p)}</>);
  return container.textContent ?? "";
}

describe("Bill of Supply — unregistered supplier", () => {
  const text = printed(bos, unregTenant);

  it("is titled Bill of Supply, never Tax Invoice", () => {
    expect(text).toContain("Bill of Supply");
    expect(text).not.toContain("Tax Invoice");
  });

  it("prints no CGST / SGST / IGST, no reverse-charge or GSTR-1 line", () => {
    /* "CGST Act" in the Rule 49 declaration is the statute, not a tax head. */
    expect(text.replace(/CGST Act/g, "")).not.toMatch(/CGST|SGST|IGST/);
    expect(text).not.toMatch(/reverse charge/i);
    expect(text).not.toMatch(/GSTR-1/);
  });

  it("says why there is no GST", () => {
    expect(text).toContain(UNREGISTERED_DECLARATION);
  });

  it("carries the Rule 49 fields: supplier name + address, number, date, recipient, HSN/SAC, description, value, signatory", () => {
    expect(text).toContain("Gupta Web Studio");
    expect(text).toContain("12 MG Road, New Delhi");
    expect(text).toContain("BOS-GWS1-27-0001");
    expect(text).toContain("Bill date");
    expect(text).toContain("Sharma Traders");
    expect(text).toContain("998314");
    expect(text).toContain("Website setup");
    expect(text).toContain("Value of supply");
    expect(text).toContain("Authorised signatory");
    expect(text).not.toContain("GSTIN:");   // an unregistered supplier has none
  });

  it("names the recipient's state from the frozen place of supply, with no GST head", () => {
    expect(text).toContain("Karnataka (29)");
  });
});

describe("Bill of Supply — composition supplier", () => {
  const compTenant = { ...unregTenant, gstin: "07ABCDE1234F1Z5" } as TenantPdfInfo;
  const text = printed({ ...bos, supplier_gst_status: "composition" } as Invoice, compTenant);

  it("carries the composition declaration and its GSTIN", () => {
    expect(text).toContain(COMPOSITION_DECLARATION);
    expect(text).toContain("GSTIN: 07ABCDE1234F1Z5");
    expect(text.replace(/CGST Act/g, "")).not.toMatch(/CGST|SGST|IGST/);
  });
});

describe("Tax Invoice — unchanged", () => {
  const regTenant = { ...unregTenant, gstin: "07ABDCA0298H1ZP" } as TenantPdfInfo;
  const taxQuote = { ...quote, tax_rate: 18, amount: 11800 } as unknown as Quote;
  const inv = {
    ...bos, id: "INV-ADPL-27-0001", amount: 11800, tax_amount: 1800, tax_rate: 18,
    document_kind: "tax_invoice", supplier_gst_status: "registered",
  } as unknown as Invoice;
  const text = printed(inv, regTenant, taxQuote);

  it("is titled Tax Invoice with CGST + SGST and no Bill-of-Supply wording", () => {
    expect(text).toContain("Tax Invoice");
    expect(text).toMatch(/CGST @ 9%/);
    expect(text).toMatch(/SGST @ 9%/);
    expect(text).not.toContain("Bill of Supply");
    expect(text).not.toContain(UNREGISTERED_DECLARATION);
  });

  it("a row from before R-1529 (no document_kind) is a Tax Invoice", () => {
    const legacy = { ...inv } as Record<string, unknown>;
    delete legacy.document_kind;
    delete legacy.supplier_gst_status;
    expect(printed(legacy as unknown as Invoice, regTenant, taxQuote)).toContain("Tax Invoice");
  });
});
