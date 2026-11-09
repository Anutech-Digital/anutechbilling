/**
 * R-2636: generate_invoice now REFUSES an export whose quote still charges GST (never CGST+SGST, never
 * re-priced). The issue confirm must say so in words that hold the Issue button ("nothing can be
 * issued" — ConfirmIssueDialog's blocking pattern), not "the invoice will too".
 */
import { describe, it, expect } from "vitest";
import { issueConsequences, type QuoteToInvoice } from "./issue-consequences";
import type { SeriesState } from "@/lib/actions/consequence";
import type { TenantLut } from "@/lib/gst/export-lut";

const SERIES: SeriesState = { prefix: "INV", docCode: "TEST", fiscalYear: "FY2627", lastNumber: 8, documentCount: 8 };
const LUTS: TenantLut[] = [
  { fyStart: "2026-04-01", arn: "AD0704260012345", validFrom: "2026-04-01", validUpto: "2027-03-31" },
];
const PEAK: QuoteToInvoice = {
  id: "Q-R2636-1", customerName: "Peak Performance Hackers", amount: 15_583, taxAmount: 2_377,
  paymentTermsDays: 30, customerGstin: null, customerCountry: "United States", luts: LUTS,
  invoiceDate: "2026-08-26", invoiceDateWhy: "receipt",
};
const BLOCKING = /no amount|nothing can be issued/i;
const warnings = (q: QuoteToInvoice) =>
  issueConsequences({ quote: q, series: SERIES }).consequences.filter((c) => c.tone === "warning").map((c) => c.text);

describe("R-2636 export quote that charges GST", () => {
  it("is held: 'nothing can be issued', with the way on (new quote at 0%)", () => {
    const w = warnings(PEAK).join(" ");
    expect(w).toMatch(BLOCKING);
    expect(w).toMatch(/charges ₹2,377 GST/);
    expect(w).toMatch(/never CGST\+SGST/);
    expect(w).toMatch(/new quote for this customer at 0% GST/);
    expect(w).not.toMatch(/the invoice will too/);
  });

  it("'Bharat' is India — no export line, nothing held for the export rule", () => {
    const w = warnings({ ...PEAK, customerCountry: "Bharat" }).join(" ");
    expect(w).not.toMatch(/export invoice/i);
    expect(w).not.toMatch(/never CGST\+SGST/);
  });

  it("a 0% export quote is not held by this rule", () => {
    const w = warnings({ ...PEAK, amount: 13_206, taxAmount: 0 }).join(" ");
    expect(w).not.toMatch(BLOCKING);
  });

  it("SEZ without payment + GST quote is still issued (IGST), not held", () => {
    const w = warnings({
      ...PEAK, customerName: "SEZ Unit Pvt Ltd", customerCountry: "India",
      customerTreatment: "sez_without_payment", customerGstin: "06AAACS1234F1Z5",
    }).join(" ");
    expect(w).toMatch(/the invoice will too/);
    expect(w).not.toMatch(BLOCKING);
  });
});
