/**
 * R-2647 (R-2635/R-2636 follow-up): the /invoices list "Generate" confirm passed only name, amount,
 * terms and GSTIN to issueConsequences — so a customer abroad read "goes out as a B2C invoice", with
 * no export/LUT/IGST line and no date. The list now hands the SAME helper the same facts the quote
 * page does (country, GST treatment, the quote's GST, the server's invoice date, the LUTs).
 */
import { describe, it, expect } from "vitest";
import { pendingQuoteToIssuable, pendingQuotesToIssuable, type PendingQuoteForIssue } from "./pending-issuable";
import { issueConsequences, bulkIssueConsequences } from "./issue-consequences";
import { isBlocked } from "@/lib/actions/consequence";
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

/* R-2651 (R-2647 follow-up): the bulk "Generate N" confirm said nothing per quote — no export /
   LUT / IGST line and no date — and could issue an export the single confirm holds (no LUT). It now
   lists, per selected quote, the SAME lines the single confirm shows (one helper, no second wording). */
describe("R-2651 /invoices bulk 'Generate N' confirm = the single confirm's lines per quote", () => {
  const INDIAN: PendingQuoteForIssue = {
    id: "Q-IN-1", customer_name: "Desi Traders", amount: 11_800, payment_terms_days: 30,
    subtotal: 10_000, discount_pct: 0, tax_rate: 18,
    customer_gstin: "07ABCDE1234F1Z5", customer_country: "India", customer_treatment: "registered",
    latest_receipt_day: "2026-09-02", part_action: { kind: "whole" },
  };
  const EXPORT: PendingQuoteForIssue = { ...ROW, latest_receipt_day: "2026-08-26" };
  const DATES: Record<string, { date: string; why: "receipt" | "today" | "first_open" }> = {
    "2026-08-26": { date: "2026-08-26", why: "receipt" },
    "2026-09-02": { date: "2026-09-02", why: "receipt" },
  };
  const ctx = (over: Partial<Parameters<typeof pendingQuotesToIssuable>[1]> = {}) => ({
    dateFor: (day: string | null) => (day ? DATES[day] : undefined),
    luts: LUTS,
    ...over,
  });
  const bulkText = (rows: PendingQuoteForIssue[], c = ctx(), series: SeriesState = SERIES) =>
    bulkIssueConsequences({ quotes: pendingQuotesToIssuable(rows, c), series }).consequences.map((x) => x.text).join(" | ");

  it("names each quote with its real date and the export line — never B2C for the customer abroad", () => {
    const t = bulkText([EXPORT, INDIAN]);
    expect(t).toMatch(/Q-USD-1 · Peak Performance Hackers: Dated 26 Aug 2026 — the day the money came in/);
    expect(t).toMatch(/export invoice to Peak Performance Hackers \(United States\): 0% GST under LUT AD0704260012345 \(FY 2026-27\)/);
    expect(t).toMatch(/Q-IN-1 · Desi Traders: Dated 2 Sept? 2026/);
    expect(t).not.toMatch(/B2C/);
  });

  it("the export words are exactly the single confirm's (one helper)", () => {
    const single = issueConsequences({
      quote: pendingQuoteToIssuable(EXPORT, { invoiceDate: "2026-08-26", invoiceDateWhy: "receipt", luts: LUTS }),
      series: SERIES,
    }).consequences.map((x) => x.text);
    const exportLine = single.find((s) => /export invoice/.test(s)) as string;
    expect(exportLine).toBeTruthy();
    expect(bulkText([EXPORT, INDIAN])).toContain(exportLine);
  });

  it("an export quote that charges GST shows the WITH payment of IGST line in bulk too", () => {
    const t = bulkText([{ ...EXPORT, amount: 15_583, tax_rate: 18 }, INDIAN]);
    expect(t).toMatch(/Q-USD-1 · Peak Performance Hackers: .*WITH payment of IGST \(₹2,377 IGST/);
  });

  it("an export with no LUT for its date's FY is held — the bulk Issue is refused and names the quote to untick", () => {
    const res = bulkIssueConsequences({ quotes: pendingQuotesToIssuable([EXPORT, INDIAN], ctx({ luts: [] })), series: SERIES });
    const t = res.consequences.map((x) => x.text).join(" | ");
    expect(t).toMatch(/Q-USD-1 · Peak Performance Hackers: .*nothing can be issued until the LUT is on file/);
    expect(t).toMatch(/Untick Q-USD-1/);
    expect(isBlocked(res.consequences)).toBe(true);
  });

  it("Overseas with no country is held in bulk too (R-2620), naming the quote", () => {
    const res = bulkIssueConsequences({
      quotes: pendingQuotesToIssuable([{ ...EXPORT, customer_country: null }, INDIAN], ctx()), series: SERIES,
    });
    const t = res.consequences.map((x) => x.text).join(" | ");
    expect(t).toMatch(/Q-USD-1 · Peak Performance Hackers: .*marked Overseas but has no country/);
    expect(t).toMatch(/Untick Q-USD-1/);
    expect(isBlocked(res.consequences)).toBe(true);
  });

  it("a date in another FY → no number range is claimed (each takes its date's FY series)", () => {
    const res = bulkIssueConsequences({
      quotes: pendingQuotesToIssuable([{ ...INDIAN, latest_receipt_day: "2026-03-20" }, EXPORT], ctx({
        dateFor: (d) => (d === "2026-03-20" ? { date: "2026-03-20", why: "receipt" } : d ? DATES[d] : undefined),
      })),
      series: SERIES,
    });
    expect(res.predictedIsCertain).toBe(false);
    expect(res.consequences[0].text).toMatch(/FY 2025-26/);
    expect(res.consequences[0].text).not.toMatch(/INV-TEST/);
  });

  it("a part row gets no date and no export claim (its own billing path decides)", () => {
    const [q] = pendingQuotesToIssuable([{ ...EXPORT, part_action: { kind: "part", amount: 5_000 } as PendingQuoteForIssue["part_action"] }], ctx());
    expect(q.invoiceDate).toBeUndefined();
    expect(q.customerCountry).toBeUndefined();
  });

  it("dates not loaded → no date line, no ARN claimed, export still not B2C", () => {
    const t = bulkText([EXPORT, INDIAN], ctx({ dateFor: () => undefined }));
    expect(t).not.toMatch(/Dated /);
    expect(t).not.toContain("AD0704260012345");
    expect(t).toMatch(/export invoice/);
    expect(t).not.toMatch(/B2C/);
  });
});

describe("R-2651 bulk confirm — review fixes", () => {
  const A: PendingQuoteForIssue = {
    id: "Q-A", customer_name: "Alpha", amount: 11_800, payment_terms_days: 30, subtotal: 10_000, discount_pct: 0,
    tax_rate: 18, customer_gstin: "07ABCDE1234F1Z5", customer_country: "India", customer_treatment: "registered",
    latest_receipt_day: "2026-09-02", part_action: { kind: "whole" },
  };
  const B: PendingQuoteForIssue = { ...A, id: "Q-B", customer_name: "Beta" };
  const dateFor = (d: string | null) => (d ? { date: d, why: "receipt" as const } : undefined);
  const run = (rows: PendingQuoteForIssue[], over: Partial<Parameters<typeof pendingQuotesToIssuable>[1]> = {}) =>
    bulkIssueConsequences({ quotes: pendingQuotesToIssuable(rows, { dateFor, luts: LUTS, ...over }), series: SERIES });
  const all = (r: ReturnType<typeof run>) => r.consequences.map((x) => x.text).join(" | ");

  it("company not GST-registered → no INV number named or claimed certain (Bill of Supply series)", () => {
    const r = run([A, B], { billOfSupply: true });
    expect(r.predictedIsCertain).toBe(false);
    expect(all(r)).toMatch(/Bill of Supply \(BOS-\) numbers/);
    expect(all(r)).not.toMatch(/INV-TEST/);
  });

  it("one ₹0 quote in the selection holds the bulk issue and is named (single confirm holds it too)", () => {
    const r = run([A, { ...B, amount: 0, subtotal: 0 }]);
    expect(all(r)).toMatch(/Q-B · Beta: .*no amount.*Untick Q-B/);
    expect(r.consequences.some((c) => c.tone === "warning" && /no amount|nothing can be issued/i.test(c.text))).toBe(true);
  });

  it("an export whose date or LUT could not be read is held in bulk (server could refuse it mid-run)", () => {
    const r = run([{ ...ROW, latest_receipt_day: "2026-08-26" }, A], { dateFor: (d) => (d === "2026-08-26" ? undefined : dateFor(d)) });
    expect(all(r)).toMatch(/Q-USD-1 · Peak Performance Hackers: .*could not be read, so nothing can be issued.*Untick Q-USD-1/);
  });

  it("same date for every quote → said once, not per quote", () => {
    const t = all(run([A, B]));
    expect(t).toMatch(/All 2: Dated 2 Sept? 2026 — the day the money came in/);
    expect(t).not.toMatch(/Q-A · Alpha/);
  });

  it("held quotes come first, right after the number line", () => {
    const r = run([A, { ...ROW, latest_receipt_day: "2026-08-26" }], { luts: [] });
    expect(r.consequences[1].text).toMatch(/^Q-USD-1 /);
  });
});
