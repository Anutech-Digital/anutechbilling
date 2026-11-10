/**
 * R-2647 (R-2635/R-2636 follow-up): the /invoices list "Generate" confirm passed only name, amount,
 * terms and GSTIN to issueConsequences — so a customer abroad read "goes out as a B2C invoice", with
 * no export/LUT/IGST line and no date. The list now hands the SAME helper the same facts the quote
 * page does (country, GST treatment, the quote's GST, the server's invoice date, the LUTs).
 */
import { describe, it, expect } from "vitest";
import { pendingQuoteToIssuable, type PendingQuoteForIssue } from "./pending-issuable";
import { issueConsequences } from "./issue-consequences";
import type { SeriesState } from "@/lib/actions/consequence";
import type { TenantLut } from "@/lib/gst/export-lut";

const SERIES: SeriesState = { prefix: "INV", docCode: "TEST", fiscalYear: "FY2627", lastNumber: 8, documentCount: 8 };
const LUTS: TenantLut[] = [
  { fyStart: "2026-04-01", arn: "AD0704260012345", validFrom: "2026-04-01", validUpto: "2027-03-31" },
];
/* A pending row as useQuotesAwaitingInvoice returns it: $139 export, 0% GST, paid 26 Aug. */
const ROW: PendingQuoteForIssue = {
  id: "Q-USD-1", customer_name: "Peak Performance Hackers", amount: 13_206, payment_terms_days: 30,
  subtotal: 13_206, discount_pct: 0, tax_rate: 0,
  customer_gstin: null, customer_country: "United States", customer_treatment: "overseas",
  part_action: { kind: "whole" },
};
const words = (row: PendingQuoteForIssue, ctx?: Parameters<typeof pendingQuoteToIssuable>[1]) =>
  issueConsequences({ quote: pendingQuoteToIssuable(row, ctx), series: SERIES }).consequences;
const text = (row: PendingQuoteForIssue, ctx?: Parameters<typeof pendingQuoteToIssuable>[1]) =>
  words(row, ctx).map((c) => c.text).join(" | ");

describe("R-2647 /invoices Generate confirm = the quote page's wording", () => {
  it("a customer abroad is never B2C; says export at 0% under the LUT of the date's FY", () => {
    const t = text(ROW, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS });
    expect(t).not.toMatch(/B2C/);
    expect(t).toMatch(/export invoice to Peak Performance Hackers \(United States\)/);
    expect(t).toContain("AD0704260012345");
    expect(t).toContain("FY 2026-27");
  });

  it("shows the server's real date and why (the receipt day, not today)", () => {
    const t = text(ROW, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS });
    expect(t).toMatch(/Dated 26 Aug 2026 — the day the money came in/);
  });

  it("first open day (GST filed / books locked) is said too", () => {
    expect(text(ROW, { invoiceDate: "2026-10-01", invoiceDateWhy: "first_open", luts: LUTS }))
      .toMatch(/the first open day/);
  });

  it("date not known yet (loading / failed) → no date line and no ARN claimed, still export not B2C", () => {
    const t = text(ROW, { luts: LUTS });
    expect(t).not.toMatch(/Dated /);
    expect(t).not.toContain("AD0704260012345");
    expect(t).toMatch(/export invoice/);
    expect(t).not.toMatch(/B2C/);
  });

  it("an export quote that charges GST → the R-2636 WITH payment of IGST line, with the quote's GST", () => {
    const row = { ...ROW, amount: 15_583, subtotal: 13_206, tax_rate: 18 };
    const t = text(row, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS });
    expect(t).toMatch(/WITH payment of IGST \(₹2,377 IGST/);
    expect(t).not.toMatch(/B2C/);
  });

  it("GST after a discount is worked like the quote page (stored total − taxable)", () => {
    const q = pendingQuoteToIssuable({ ...ROW, subtotal: 10_000, discount_pct: 10, tax_rate: 18, amount: 10_620 });
    expect(q.taxAmount).toBe(1_620);
  });

  it("Overseas with no country → the R-2620 block, not B2C", () => {
    const t = text({ ...ROW, customer_country: null }, { luts: LUTS });
    expect(t).toMatch(/marked Overseas but has no country/);
    expect(t).not.toMatch(/B2C/);
  });

  it("an Indian customer without GSTIN still gets the B2C reminder", () => {
    const t = text({ ...ROW, customer_country: null, customer_treatment: "unregistered", tax_rate: 18, amount: 15_583 });
    expect(t).toMatch(/goes out as a B2C invoice/);
  });

  it("customer facts not loaded (undefined) → says nothing about export, as before", () => {
    const q = pendingQuoteToIssuable({ ...ROW, customer_country: undefined, customer_treatment: undefined });
    expect(q.customerCountry).toBeUndefined();
    expect(text({ ...ROW, customer_country: undefined })).not.toMatch(/export invoice/);
  });

  it("GSTIN lookup failed (undefined) → no B2C warning, still undefined on the quote", () => {
    const row = { ...ROW, customer_gstin: undefined, customer_country: undefined, customer_treatment: undefined };
    expect(pendingQuoteToIssuable(row).customerGstin).toBeUndefined();
    expect(text(row)).not.toMatch(/B2C/);
  });

  it("no subtotal stored → GST worked back from total and rate, so the IGST line still shows", () => {
    const row = { ...ROW, subtotal: null, amount: 15_583, tax_rate: 18 };
    expect(pendingQuoteToIssuable(row).taxAmount).toBe(2_377);
    expect(text(row, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS })).toMatch(/WITH payment of IGST/);
  });

  it("company not GST-registered → Bill of Supply, no export/LUT line (as on the quote page)", () => {
    const t = text(ROW, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS, billOfSupply: true });
    expect(t).toMatch(/Bill of Supply/);
    expect(t).not.toMatch(/export invoice/);
  });

  it("a part row bills the part amount and claims no GST figure for the whole year", () => {
    const q = pendingQuoteToIssuable({
      ...ROW, amount: 40_000, tax_rate: 18,
      part_action: { kind: "part", amount: 10_000 } as PendingQuoteForIssue["part_action"],
    });
    expect(q.amount).toBe(10_000);
    expect(q.taxAmount).toBeUndefined();
    expect(q.customerCountry).toBeUndefined();
  });
});
