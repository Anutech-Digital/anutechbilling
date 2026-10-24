// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-1532 — a business that is NOT GST-registered (or under composition) issues a Bill of
   Supply. Since R-1529 the database refuses an invoice from a quote that carries GST, so its
   quotes must start at 0% and every customer document — PDF, accept page, email — must say
   "No GST — Bill of Supply" and print no CGST / SGST / IGST rows. Registered: unchanged.
   Each document is rendered for real (react-pdf primitives as div/span) and its text read.
   ───────────────────────────────────────────────────────────────────────────── */
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

import { QuotePDF } from "./QuotePDF";
import { buildQuotePdfProps, type TenantPdfInfo } from "./build-props";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { TaxRows } from "@/app/(public)/quote/[id]/accept/quote-accept-view";
import { quoteEmailBody } from "@/lib/email/quote-body";
import { planQuoteFromEnquiry } from "@/lib/quotes/quote-from-enquiry";
import { extensionCharge } from "@/lib/renewals/extension-term";
import { readTenantGstRegistration } from "@/lib/compliance/gst-registration-server";
import {
  billOfSupplyStatus, quoteStartTaxRate, quoteEffectiveTaxRate, quoteDocBillOfSupply,
  billOfSupplyPlaceLabel, billOfSupplyBuilderLine, billOfSupplyCustomerLine,
} from "@/lib/quotes/bill-of-supply";
import type { Quote, QuoteLineItem } from "@/lib/supabase/database.types";

afterEach(cleanup);

const HEADS = /CGST|SGST|IGST/;
const UNREG_LINE = "No GST — Bill of Supply (supplier is not registered under GST)";
const COMP_LINE = "No GST — Bill of Supply (composition taxable person, not eligible to collect tax on supplies)";

/* Owner's example: 2 × Business Starter ₹1,500/yr, a Haryana buyer, quote saved at 0%. */
const lines = [{ id: "l1", name: "Google Workspace Business Starter", qty: 2, rate: 1500, cost: 1200, commitment: "annual_yearly" }] as unknown as QuoteLineItem[];
const zero = { lineItems: lines, subtotal: 3000, discountPct: 0, discount: 0, taxable: 3000, taxRate: 0, tax: 0, total: 3000 };
const gst18 = { lineItems: lines, subtotal: 3000, discountPct: 0, discount: 0, taxable: 3000, taxRate: 18, tax: 540, total: 3540 };

describe("the rule (lib/quotes/bill-of-supply)", () => {
  it("not registered / composition start at 0% and stay at 0; registered and not-chosen stay 18%", () => {
    expect(billOfSupplyStatus("unregistered")).toBe("unregistered");
    expect(billOfSupplyStatus("composition")).toBe("composition");
    expect(billOfSupplyStatus("registered")).toBeNull();
    expect(billOfSupplyStatus(null)).toBeNull();
    expect(quoteStartTaxRate("unregistered")).toBe(0);
    expect(quoteStartTaxRate("composition")).toBe(0);
    expect(quoteStartTaxRate("registered")).toBe(18);
    expect(quoteStartTaxRate(null)).toBe(18);
    // The rate cannot be raised on a Bill of Supply business's quote.
    expect(quoteEffectiveTaxRate({ saved: "unregistered", isExport: false, taxRate: 18 })).toBe(0);
    expect(quoteEffectiveTaxRate({ saved: "registered", isExport: false, taxRate: 18 })).toBe(18);
    expect(quoteEffectiveTaxRate({ saved: "registered", isExport: true, taxRate: 18 })).toBe(0);
  });

  it("an older quote saved at 18% is not rewritten — its document keeps its GST", () => {
    expect(quoteDocBillOfSupply("unregistered", 18)).toBeNull();
    expect(quoteDocBillOfSupply("unregistered", 0)).toBe("unregistered");
    expect(quoteDocBillOfSupply("registered", 0)).toBeNull();
  });

  it("wording: staff line names your business, customer line names the supplier", () => {
    expect(billOfSupplyBuilderLine("unregistered")).toBe("No GST — Bill of Supply (your business is not GST-registered)");
    expect(billOfSupplyBuilderLine("composition")).toBe("No GST — Bill of Supply (your business is under the GST composition scheme)");
    expect(billOfSupplyCustomerLine("unregistered")).toBe(UNREG_LINE);
    expect(billOfSupplyCustomerLine("composition")).toBe(COMP_LINE);
  });

  it("place of supply keeps the state, drops the tax head", () => {
    expect(billOfSupplyPlaceLabel("Haryana (06) · IGST")).toBe("Haryana (06)");
    expect(billOfSupplyPlaceLabel("Delhi (07) · CGST + SGST")).toBe("Delhi (07)");
    expect(billOfSupplyPlaceLabel("Intra-state (CGST + SGST)")).toBe("—");
    expect(billOfSupplyPlaceLabel(null)).toBe("—");
  });
});

function pdfText(props: Partial<React.ComponentProps<typeof QuotePDF>>) {
  const { container } = render(
    <QuotePDF tenantName="Sharma IT Services" quoteId="Q-1532" customerName="Sharma Traders" validityDays={30}
      interState={false} billingCycle="yearly" placeOfSupply="Haryana (06) · CGST + SGST" {...zero} {...props} />,
  );
  return container.textContent ?? "";
}

describe("quote PDF", () => {
  it("not registered → Bill of Supply line, no CGST/SGST/IGST", () => {
    const t = pdfText({ billOfSupply: "unregistered" });
    expect(t).toContain(UNREG_LINE);
    expect(t).not.toMatch(HEADS);
    expect(t).toContain("Haryana (06)");
  });

  it("composition → composition wording, no heads", () => {
    const t = pdfText({ billOfSupply: "composition" });
    expect(t).toContain(COMP_LINE);
    expect(t).not.toMatch(HEADS);
  });

  it("Proforma of a Bill of Supply business promises a Bill of Supply, not a GST tax invoice", () => {
    const t = pdfText({ billOfSupply: "unregistered", template: "proforma" });
    expect(t).toContain("A Bill of Supply will be issued on payment.");
    expect(t).not.toContain("A GST tax invoice will be issued");
  });

  it("registered → CGST + SGST as before", () => {
    const t = pdfText({ ...gst18 });
    expect(t).toContain("CGST (9%)");
    expect(t).toContain("SGST (9%)");
    expect(t).not.toContain("Bill of Supply");
  });

  it("buildQuotePdfProps (public PDF link): Bill of Supply only on a 0% quote of such a business", () => {
    const tenant = { name: "Sharma IT Services", gstin: null, email: null, phone: null, address: null, state: "Haryana",
      state_code: "06", logo_url: null, upi_vpa: null, remit_bank_name: null, remit_account_name: null,
      remit_account_number: null, remit_ifsc: null, remit_branch: null } as TenantPdfInfo;
    const q = (tax_rate: number, amount: number) => ({ id: "Q-1532", customer_name: "Sharma Traders", subtotal: 3000,
      discount_pct: 0, tax_rate, amount, line_items: lines, created_date: "2026-10-23", expires_date: "2026-11-22",
      notes: null, is_renewal: false } as unknown as Quote);
    expect(buildQuotePdfProps({ quote: q(0, 3000), customer: null, tenant, gstRegistration: "unregistered" }).billOfSupply).toBe("unregistered");
    expect(buildQuotePdfProps({ quote: q(0, 3000), customer: null, tenant, gstRegistration: "composition" }).billOfSupply).toBe("composition");
    expect(buildQuotePdfProps({ quote: q(18, 3540), customer: null, tenant, gstRegistration: "unregistered" }).billOfSupply).toBeNull();
    expect(buildQuotePdfProps({ quote: q(18, 3540), customer: null, tenant, gstRegistration: "registered" }).billOfSupply).toBeNull();
    expect(buildQuotePdfProps({ quote: q(18, 3540), customer: null, tenant }).billOfSupply).toBeNull();
  });
});

describe("in-app preview, accept page, email", () => {
  it("preview dialog → Bill of Supply line, no heads", () => {
    render(
      <QuotePreviewDialog open onOpenChange={() => {}} tenantName="Sharma IT Services" quoteId="Q-1532"
        customerName="Sharma Traders" interState={false} billingCycle="yearly" validityDays={30} notes=""
        placeOfSupply="Haryana (06) · CGST + SGST" billOfSupply="unregistered" {...zero} />,
    );
    const t = document.body.textContent ?? "";
    expect(t).toContain(UNREG_LINE);
    expect(t).not.toMatch(HEADS);
  });

  it("accept page tax rows → Bill of Supply line; registered keeps CGST + SGST", () => {
    const fmt = (v: number) => `₹${v}`;
    const { container, rerender } = render(<TaxRows taxRate={0} tax={0} interState={false} fmt={fmt} billOfSupply="composition" />);
    expect(container.textContent).toBe(COMP_LINE);
    rerender(<TaxRows taxRate={18} tax={540} interState={false} fmt={fmt} />);
    expect(container.textContent).toMatch(/CGST \(9%\).*SGST \(9%\)/);
  });

  it("quote email → Bill of Supply line, no heads, promises a Bill of Supply", () => {
    const body = quoteEmailBody({
      quoteId: "Q-1532", customerName: "Sharma Traders",
      supplier: { name: "Sharma IT Services", gstin: null, address: "Gurugram", state: "Haryana", email: "a@b.in", phone: "1" },
      interState: false, billingCycle: "yearly", createdDate: "2026-10-23", expiresDate: "2026-11-22",
      billOfSupply: "unregistered", ...zero,
    });
    expect(body).toContain(UNREG_LINE);
    expect(body).not.toMatch(HEADS);
    expect(body).toContain("we will raise the Bill of Supply");
    expect(body).not.toContain("intra-state");
  });
});

describe("server quote paths price at 0% for a Bill of Supply business", () => {
  it("auto quote from an email enquiry: amount = taxable, no 18% added", () => {
    const item = { id: "GW-STR", name: "Google Workspace Business Starter", msrp: 270, wholesale: 110 };
    const bos = planQuoteFromEnquiry({ item, seats: 2, newLineId: () => "l1", taxRatePct: 0 });
    const reg = planQuoteFromEnquiry({ item, seats: 2, newLineId: () => "l1" });
    expect(bos.ok && reg.ok).toBe(true);
    if (!bos.ok || !reg.ok) return;
    expect(bos.amount).toBe(bos.subtotal);           // 2 × ₹3,240 = ₹6,480, no GST
    expect(reg.amount).toBe(Math.round(reg.subtotal * 1.18));
  });

  it("extension quote: 0% → total = subtotal", () => {
    const c = extensionCharge({ seats: 2, mrr: 540, len: { unit: "years", count: 1 }, taxRatePct: quoteStartTaxRate("unregistered") });
    expect(c.tax).toBe(0);
    expect(c.total).toBe(c.subtotal);
  });

  it("reading the tenant's status never breaks a document: error / missing column → null (registered)", async () => {
    const client = (result: unknown) => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }),
    }) as never;
    expect(await readTenantGstRegistration(client({ data: { gst_registration: "unregistered" }, error: null }), "t1")).toBe("unregistered");
    expect(await readTenantGstRegistration(client({ data: null, error: { code: "42703", message: "column does not exist" } }), "t1")).toBeNull();
    expect(await readTenantGstRegistration(client({ data: { gst_registration: "junk" }, error: null }), "t1")).toBeNull();
    expect(await readTenantGstRegistration(client({ data: null, error: null }), null)).toBeNull();
  });
});
