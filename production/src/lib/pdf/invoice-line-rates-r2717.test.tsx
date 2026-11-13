// @vitest-environment jsdom
/* R-2717 — the invoice PDF of an invoice whose lines carry different GST rates.
   Owner's example (R-2702: INV/25-26/1248): a 0% line ₹10,000 + an 18% line ₹20,000, IGST
   ₹3,600, total ₹33,600; invoices.tax_rate NULL. Before: one "IGST @ 18%" row (tax_rate ?? 18)
   and no rate on the lines — the 0% line read as taxed at 18%.
   Rendered with @react-pdf primitives mocked to div/span (as in invoice-sez-endorsement.test.tsx). */
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
import type { Customer, Invoice, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const lines = [
  { id: "l1", name: "Domain renewal", qty: 1, rate: 10000, hsn: "998315", tax_rate: 0 },
  { id: "l2", name: "Google Workspace", qty: 2, rate: 10000, hsn: "998313", tax_rate: 18 },
] as unknown as QuoteLineItem[];
const tenant = {
  name: "ANUTECH DIGITAL PVT LTD", gstin: "07ABDCA0298H1ZP", email: null, phone: null,
  address: "New Delhi", state: "Delhi", state_code: "07", lut_number: null,
} as TenantPdfInfo;
const customer = { id: "c1", name: "Acme Pvt Ltd", gstin: "29AAACA1111A1Z5", state_code: "29", state: "Karnataka", country: "India", gst_treatment: "regular" } as unknown as Customer;
const mixedInvoice = {
  id: "INV/25-26/1248", tenant_id: "t", customer_id: "c1", customer_name: "Acme Pvt Ltd",
  amount: 33600, taxable_value: 30000, tax_amount: 3600, tax_rate: null, inter_state: true,
  invoice_date: "2025-11-10", due_date: "2025-11-25", paid_date: null, adjusted_advances: [], net_payable: 33600,
  quote_id: null, line_items: lines, paid_amount: 0, status: "pending",
  currency: null, fx_rate: null, fx_source: null, fx_date: null,
  document_kind: "tax_invoice", customer_gstin: "29AAACA1111A1Z5", pos_state_code: "29", customer_country: "India",
  gst_treatment: "regular",
} as unknown as Invoice;

function printed(invoice: Invoice, c: Customer = customer): string {
  const p = buildInvoicePdfProps({ invoice, quote: null, customer: c, tenant }) as InvoicePDFProps;
  const { container } = render(<>{InvoicePDF(p)}</>);
  return (container.textContent ?? "").replace(/ /g, " ");
}

describe("R-2717 invoice PDF with lines at different GST rates", () => {
  it("inter-state: GST % on each line and one IGST row per rate — never a single 'IGST @ 18%'", () => {
    const text = printed(mixedInvoice);
    expect(text).toContain("GST 0%");
    expect(text).toContain("GST 18%");
    expect(text).toMatch(/IGST @ 0% on [^0-9]*10,000/);
    expect(text).toMatch(/IGST @ 18% on [^0-9]*20,000/);
    expect(text).toMatch(/3,600/);
    expect(text).not.toMatch(/IGST @ 18%(?! on)/);
  });

  it("intra-state: CGST + SGST halves per rate", () => {
    const text = printed(
      { ...mixedInvoice, inter_state: false, customer_gstin: "07AAACA1111A1Z5", pos_state_code: "07" } as Invoice,
      { ...customer, gstin: "07AAACA1111A1Z5", state_code: "07", state: "Delhi" } as Customer,
    );
    expect(text).toMatch(/CGST @ 9% on [^0-9]*20,000/);
    expect(text).toMatch(/SGST @ 9% on [^0-9]*20,000/);
    expect(text).toMatch(/CGST @ 0% on [^0-9]*10,000/);
    expect(text).toMatch(/1,800/);
    expect(text).not.toMatch(/IGST @/);
  });

  it("tax_rate NULL but every line at 5% → one 'IGST @ 5%' row, never the 18% default", () => {
    const five = { ...mixedInvoice, tax_amount: 1500, amount: 31500, net_payable: 31500, line_items: lines.map((l) => ({ ...l, tax_rate: 5 })) } as unknown as Invoice;
    const text = printed(five);
    expect(text).toContain("IGST @ 5%");
    expect(text).not.toContain("IGST @ 18%");
    expect(text).not.toMatch(/IGST @ 5% on/);
  });

  it("a single-rate invoice prints as before: one IGST row, no GST % on the lines", () => {
    const one = { ...mixedInvoice, tax_rate: 18, tax_amount: 5400, amount: 35400, net_payable: 35400, line_items: lines.map((l) => ({ ...l, tax_rate: undefined })) } as unknown as Invoice;
    const text = printed(one);
    expect(text).toContain("IGST @ 18%");
    expect(text).not.toMatch(/IGST @ 18% on/);
    expect(text).not.toMatch(/GST 18%(?!\d)/);
    expect(text).not.toContain("GST 0%");
  });
});
