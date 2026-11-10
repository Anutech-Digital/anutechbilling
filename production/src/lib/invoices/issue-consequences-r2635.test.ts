/**
 * R-2635 (split of R-2171 item 3): "Generate GST Invoice" for an Overseas customer said "goes out as
 * a B2C invoice" and "Dated <today> (today)". Both false: an export is 0% under the LUT of its date's
 * FY (R-2444), and generate_invoice dates the invoice on the latest receipt's IST day (R-2095).
 */
import { describe, it, expect } from "vitest";
import { issueConsequences, type QuoteToInvoice } from "./issue-consequences";
import { latestReceiptIstDay, invoiceDateWhy } from "./issue-date";
import type { SeriesState } from "@/lib/actions/consequence";
import type { TenantLut } from "@/lib/gst/export-lut";

const SERIES: SeriesState = { prefix: "INV", docCode: "TEST", fiscalYear: "FY2627", lastNumber: 8, documentCount: 8 };
const LUTS: TenantLut[] = [
  { fyStart: "2026-04-01", arn: "AD0704260012345", validFrom: "2026-04-01", validUpto: "2027-03-31" },
];
/* Peak Performance Hackers (staging Sep reconcile): $139 one-time, paid 26 Aug 2026, no GSTIN. */
const PEAK: QuoteToInvoice = {
  id: "Q-SCN-USD-1", customerName: "Peak Performance Hackers", amount: 13_206, taxAmount: 0,
  paymentTermsDays: 30, customerGstin: null, customerCountry: "United States", luts: LUTS,
  invoiceDate: "2026-08-26", invoiceDateWhy: "receipt",
};
const text = (q: QuoteToInvoice) => issueConsequences({ quote: q, series: SERIES }).consequences.map((c) => c.text).join(" | ");
const warnings = (q: QuoteToInvoice) =>
  issueConsequences({ quote: q, series: SERIES }).consequences.filter((c) => c.tone === "warning").map((c) => c.text);

describe("R-2635 export customer on the issue confirm", () => {
  it("never calls an overseas customer's invoice B2C", () => {
    expect(text(PEAK)).not.toMatch(/B2C/);
    expect(text(PEAK)).not.toMatch(/No GSTIN on file/);
  });

  it("says Export, 0% GST under the LUT of the invoice date's FY, with the Rule 46 endorsement", () => {
    const t = text(PEAK);
    expect(t).toMatch(/export invoice/i);
    expect(t).toContain("United States");
    expect(t).toContain("0% GST");
    expect(t).toContain("AD0704260012345");
    expect(t).toContain("FY 2026-27");
    expect(t).toContain("SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX");
    expect(warnings(PEAK)).toEqual([]);
  });

  it("no LUT for that FY → a warning with the server's own refusal and the way on", () => {
    const w = warnings({ ...PEAK, invoiceDate: "2025-09-10", luts: LUTS }).join(" ");
    expect(w).toMatch(/No LUT for FY 2025-26/);
    expect(w).toMatch(/Settings → Company → LUT/);
  });

  it("LUT list not loaded (undefined) → says export 0% but claims no ARN", () => {
    const t = text({ ...PEAK, luts: undefined });
    expect(t).toMatch(/export invoice/i);
    expect(t).not.toContain("AD0704260012345");
    expect(warnings({ ...PEAK, luts: undefined })).toEqual([]);
  });

  it("an export quote that still charges GST is warned, not called 0%", () => {
    const q = { ...PEAK, amount: 15_583, taxAmount: 2_377 };
    const w = warnings(q).join(" ");
    expect(w).toMatch(/charges ₹2,377 GST/);
    expect(w).toMatch(/not 0% under your LUT/);
    expect(text(q)).not.toMatch(/0% GST under LUT/);
  });

  it("SEZ without payment → zero-rated under the LUT too (R-2515)", () => {
    const t = text({ ...PEAK, customerName: "SEZ Unit Pvt Ltd", customerCountry: "India", customerTreatment: "sez_without_payment", customerGstin: "06AAACS1234F1Z5" });
    expect(t).toMatch(/SEZ/);
    expect(t).toContain("AD0704260012345");
  });

  it("an Indian customer with no GSTIN still gets the B2C reminder (unchanged)", () => {
    const t = text({ ...PEAK, customerName: "Kailash", customerCountry: "India", taxAmount: 18_000 });
    expect(t).toMatch(/B2C invoice/);
    expect(t).not.toMatch(/export invoice/i);
  });

  it("empty country = India (money-rules G5): no export line", () => {
    expect(text({ ...PEAK, customerCountry: "" })).not.toMatch(/export invoice/i);
  });

  it("country not passed (undefined) → nothing about export, as before", () => {
    expect(text({ ...PEAK, customerCountry: undefined })).not.toMatch(/export invoice/i);
  });

  it("no LUT → the warning holds the Issue button (ConfirmIssueDialog's 'nothing can be issued')", () => {
    const w = warnings({ ...PEAK, luts: [] }).join(" ");
    expect(w).toMatch(/nothing can be issued/);
  });

  it("SEZ with no LUT is not called an export sale", () => {
    const w = warnings({ ...PEAK, customerName: "SEZ Unit", customerCountry: "India", customerTreatment: "sez_without_payment", luts: [] }).join(" ");
    expect(w).toMatch(/A 0% SEZ supply/);
    expect(w).not.toMatch(/An export/);
  });

  it("Overseas with no country (R-2620) → held with the fix, never B2C", () => {
    const w = warnings({ ...PEAK, customerCountry: "", customerTreatment: "overseas" }).join(" ");
    expect(w).toMatch(/marked Overseas but has no country, so nothing can be issued/);
    expect(text({ ...PEAK, customerCountry: "", customerTreatment: "overseas" })).not.toMatch(/B2C/);
  });

  it("a Bill of Supply business abroad: no export / LUT line (the server leaves BOS alone)", () => {
    const t = text({ ...PEAK, billOfSupply: true, luts: [] });
    expect(t).not.toMatch(/export invoice|LUT/);
  });

  it("an invoice dated in an earlier FY takes THAT year's series, not this year's predicted number", () => {
    const c = issueConsequences({ quote: { ...PEAK, invoiceDate: "2026-03-28", invoiceDateWhy: "receipt" }, series: SERIES });
    const t = c.consequences.map((x) => x.text).join(" | ");
    expect(t).toMatch(/the next number of the FY 2025-26 series/);
    expect(t).not.toContain("INV-TEST-27-0009");
    expect(c.predictedIsCertain).toBe(false);
  });
});

describe("R-2635 the date the invoice will really carry", () => {
  it("dated on the receipt day says so, not '(today)'", () => {
    const t = text(PEAK);
    expect(t).toMatch(/Dated 26 Aug 2026/);
    expect(t).not.toMatch(/\(today\)/);
    expect(t).toMatch(/money came in/);
  });

  it("dated on the first open day (R-2631: GST filed / books locked before it) says so", () => {
    const t = text({ ...PEAK, invoiceDate: "2026-10-01", invoiceDateWhy: "first_open" });
    expect(t).toMatch(/Dated 1 Oct 2026 — the first open day: GST for the days before it is already filed or the books are locked/);
    expect(t).not.toMatch(/\(today\)/);
  });

  it("no why given → '(today)' as before", () => {
    expect(text({ ...PEAK, invoiceDateWhy: undefined })).toMatch(/Dated 26 Aug 2026 \(today\)/);
  });
});

describe("R-2635 latestReceiptIstDay / invoiceDateWhy (twin of generate_invoice's date)", () => {
  it("latest RECEIVED payment, as its IST day (19:00 UTC = next IST day)", () => {
    expect(latestReceiptIstDay([
      { status: "received", received_at: "2026-08-20T05:00:00Z" },
      { status: "received", received_at: "2026-08-25T19:00:00Z" },
      { status: "refunded", received_at: "2026-09-02T05:00:00Z" },
    ])).toBe("2026-08-26");
  });
  it("no received payment → null", () => {
    expect(latestReceiptIstDay([])).toBeNull();
    expect(latestReceiptIstDay(null)).toBeNull();
  });
  it("why: today / receipt / first_open (R-2631)", () => {
    expect(invoiceDateWhy({ date: "2026-11-09", receiptDay: null, today: "2026-11-09" })).toBe("today");
    expect(invoiceDateWhy({ date: "2026-08-26", receiptDay: "2026-08-26", today: "2026-11-09" })).toBe("receipt");
    expect(invoiceDateWhy({ date: "2026-11-09", receiptDay: "2026-11-09", today: "2026-11-09" })).toBe("today");
    expect(invoiceDateWhy({ date: "2026-09-01", receiptDay: "2026-08-26", today: "2026-11-09" })).toBe("first_open");
    /* R-2631: a 23 Sep receipt with GST filed up to Sep → the server says 1 Oct. */
    expect(invoiceDateWhy({ date: "2026-10-01", receiptDay: "2026-09-23", today: "2026-11-09" })).toBe("first_open");
    /* R-2631 review: the first open day that happens to be today still says why (the receipt's month is filed). */
    expect(invoiceDateWhy({ date: "2026-11-01", receiptDay: "2026-09-23", today: "2026-11-01" })).toBe("first_open");
  });
});
