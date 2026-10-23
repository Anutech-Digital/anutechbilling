import { describe, it, expect } from "vitest";
import {
  issueConsequences,
  bulkIssueConsequences,
  type QuoteToInvoice,
} from "./issue-consequences";
import { formatDocumentNumber, type SeriesState } from "@/lib/actions/consequence";

/* ANUTECH's real state, measured 23 Aug 2026: doc_code ADPL, FY2627 series at 32,
   and ZERO invoices on the books. */
const ANUTECH: SeriesState = {
  prefix: "INV", docCode: "ADPL", fiscalYear: "FY2627",
  lastNumber: 32, documentCount: 0,
};

/* The sandbox, whose numbers and invoices agree — the healthy shape. */
const HEALTHY: SeriesState = {
  prefix: "INV", docCode: "TEST", fiscalYear: "FY2627",
  lastNumber: 8, documentCount: 8,
};

const QUOTE: QuoteToInvoice = {
  id: "Q-2026-0041", customerName: "Kailash Corporation",
  amount: 118_000, paymentTermsDays: null,
};

const text = (c: { consequences: { text: string }[] }) => c.consequences.map((x) => x.text).join(" | ");

describe("formatDocumentNumber", () => {
  it("matches the shape the database allocates", () => {
    /* R-015 (29 Sep 2026): 21 characters -> 16, because CGST Rule 46(b) allows 16 and
       this app was issuing INV-TEST-2026-27-0008. The FY is its END year now. */
    expect(formatDocumentNumber(HEALTHY, 8)).toBe("INV-TEST-27-0008");
    expect(formatDocumentNumber(ANUTECH, 33)).toBe("INV-ADPL-27-0033");
    expect(formatDocumentNumber(ANUTECH, 33).length).toBeLessThanOrEqual(16);
  });

  it("omits the doc code when the tenant has none", () => {
    /* Demo Co' row has doc_code null. A literal "INV-null-…" on a tax
       document would be worse than the missing segment. */
    const noCode: SeriesState = { ...HEALTHY, docCode: null };
    expect(formatDocumentNumber(noCode, 3)).toBe("INV-27-0003");
    expect(formatDocumentNumber({ ...HEALTHY, docCode: "   " }, 3)).toBe("INV-27-0003");
  });

  it("pads to four digits and does not truncate beyond them", () => {
    expect(formatDocumentNumber(HEALTHY, 1)).toContain("-0001");
    expect(formatDocumentNumber(HEALTHY, 12345)).toContain("-12345");
  });

  it("passes an unexpected fiscal-year format through rather than mangling it", () => {
    expect(formatDocumentNumber({ ...HEALTHY, fiscalYear: "2026-27" }, 1))
      .toBe("INV-TEST-2026-27-0001");
  });
});

describe("issueConsequences", () => {
  it("names the exact number that will be taken", () => {
    const c = issueConsequences({ quote: QUOTE, series: ANUTECH });
    expect(c.predictedNumber).toBe("INV-ADPL-27-0033");
    expect(c.predictedIsCertain).toBe(true);
    expect(text(c)).toContain("INV-ADPL-27-0033");
  });

  it("says the number is used up either way", () => {
    /* A deleted invoice retires its serial (migration 0118). An operator who thinks
       "I'll just delete it if it's wrong" needs to know that does not give the number
       back. */
    expect(text(issueConsequences({ quote: QUOTE, series: ANUTECH })))
      .toMatch(/used up either way|retires it/i);
  });

  it("states that the invoice cannot be edited, and what to do instead", () => {
    /* True only since 20260823090000. Before that guard the click was recoverable by
       a quiet UPDATE — so this sentence had to arrive with the guard, not after it. */
    const t = text(issueConsequences({ quote: QUOTE, series: HEALTHY }));
    expect(t).toMatch(/cannot be edited/i);
    expect(t).toMatch(/credit note/i);
  });

  it("names the amount and the customer", () => {
    const t = text(issueConsequences({ quote: QUOTE, series: HEALTHY }));
    expect(t).toContain("₹1,18,000");
    expect(t).toContain("Kailash Corporation");
  });

  it("warns, rather than reassures, when the quote has no amount", () => {
    /* generate_invoice refuses a ₹0 quote (#26), so this is a block and must not read
       like a note. */
    const c = issueConsequences({ quote: { ...QUOTE, amount: 0 }, series: HEALTHY });
    expect(c.consequences.some((x) => x.tone === "warning" && /no amount/i.test(x.text))).toBe(true);
  });

  it("explains which due date applies — the net-30 fallback", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, paymentTermsDays: null }, series: HEALTHY }));
    expect(t).toMatch(/30 days from today/i);
  });

  it("warns when the terms are 0 days, because the chasing starts tomorrow", () => {
    /* The state every invoice was in before 20260822190000. If a quote still carries
       an explicit 0, the operator should see the consequence before issuing. */
    const c = issueConsequences({ quote: { ...QUOTE, paymentTermsDays: 0 }, series: HEALTHY });
    expect(c.consequences.some((x) => x.tone === "warning" && /overdue tomorrow/i.test(x.text))).toBe(true);
  });

  it("uses the quote's own terms when it has them", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, paymentTermsDays: 45 }, series: HEALTHY }));
    expect(t).toContain("45 days");
    expect(t).not.toMatch(/30 days from today/i);
  });

  it("raises the series gap when numbers are used but no invoices exist", () => {
    /* ANUTECH's actual state. Showing "0033" to somebody who has never issued an
       invoice is the alarm; this spells out why. */
    const c = issueConsequences({ quote: QUOTE, series: ANUTECH });
    const warn = c.consequences.find((x) => x.tone === "warning");
    expect(warn?.text).toMatch(/32 numbers/i);
    expect(warn?.text).toMatch(/auditor/i);
  });

  it("raises a partial gap too", () => {
    const c = issueConsequences({
      quote: QUOTE,
      series: { ...HEALTHY, lastNumber: 10, documentCount: 8 },
    });
    expect(c.consequences.some((x) => /2 numbers.*no invoice/i.test(x.text))).toBe(true);
  });

  it("stays quiet when the series and the books agree", () => {
    /* A warning that fires on the healthy case is a warning nobody reads. */
    const c = issueConsequences({ quote: QUOTE, series: HEALTHY });
    expect(c.consequences.filter((x) => x.tone === "warning")).toEqual([]);
  });

  it("does not claim certainty it cannot have when there is no series row", () => {
    /* The first invoice of a financial year. Predicting a number here would be a
       guess dressed as a fact. */
    const c = issueConsequences({ quote: QUOTE, series: null });
    expect(c.predictedIsCertain).toBe(false);
    expect(text(c)).toMatch(/first invoice of/i);
  });
});

describe("bulkIssueConsequences", () => {
  const three: QuoteToInvoice[] = [
    { ...QUOTE, id: "Q-1", amount: 100_000 },
    { ...QUOTE, id: "Q-2", amount: 50_000 },
    { ...QUOTE, id: "Q-3", amount: 25_000 },
  ];

  it("names the whole range of numbers one click will consume", () => {
    /* The dangerous path: the old bulk button looped generateInvoice over every
       selected quote with no confirmation, so one click could burn a run. */
    const c = bulkIssueConsequences({ quotes: three, series: ANUTECH });
    expect(c.predictedNumber).toBe("INV-ADPL-27-0033 … INV-ADPL-27-0035");
    expect(text(c)).toContain("Issues 3 invoices");
  });

  it("totals the money across the selection", () => {
    expect(text(bulkIssueConsequences({ quotes: three, series: HEALTHY })))
      .toContain("₹1,75,000");
  });

  it("warns that a partial failure leaves numbers already used", () => {
    /* The old loop counted ok/fail and carried on. "3 failed" and "2 issued, 1 failed"
       are different situations and only one of them leaves gaps. */
    const c = bulkIssueConsequences({ quotes: three, series: HEALTHY });
    expect(c.consequences.some((x) => x.tone === "warning" && /one at a time|already issued/i.test(x.text))).toBe(true);
  });

  it("reads naturally for a single selection", () => {
    const c = bulkIssueConsequences({ quotes: [three[0]], series: ANUTECH });
    expect(c.predictedNumber).toBe("INV-ADPL-27-0033");
    expect(text(c)).toContain("Issues 1 invoice ");
    /* No partial-failure warning: there is no "partway" with one item. */
    expect(text(c)).not.toMatch(/one at a time/i);
  });

  it("warns when nothing in the selection carries an amount", () => {
    const c = bulkIssueConsequences({
      quotes: three.map((q) => ({ ...q, amount: 0 })),
      series: HEALTHY,
    });
    expect(c.consequences.some((x) => x.tone === "warning" && /nothing can be issued/i.test(x.text))).toBe(true);
  });
});

/* R-1633 (19 Oct 2026 audit): the quote page and the project milestone issued a GST invoice in
   one click. Their confirm shows what will be issued — customer, GSTIN, amount with GST,
   invoice date and the number's series. */
describe("issueConsequences — R-1633 facts for the one-click paths", () => {
  it("names the buyer's GSTIN when there is one", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, customerGstin: "07AAACK1234F1Z5" }, series: HEALTHY }));
    expect(t).toContain("Kailash Corporation");
    expect(t).toContain("GSTIN 07AAACK1234F1Z5");
  });

  it("states the amount WITH the GST in it", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, taxAmount: 18_000 }, series: HEALTHY }));
    expect(t).toContain("₹1,18,000");
    expect(t).toMatch(/including ₹18,000 GST/);
  });

  it("states the invoice date", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, invoiceDate: "2026-10-24" }, series: HEALTHY }));
    expect(t).toMatch(/Dated 24 Oct 2026/);
  });

  it("a milestone's own due date replaces the quote-terms line", () => {
    const t = text(issueConsequences({ quote: { ...QUOTE, dueDate: "2026-11-30" }, series: HEALTHY }));
    expect(t).toMatch(/Falls due on 30 Nov 2026/);
    expect(t).not.toMatch(/30 days from today/i);
  });

  it("a Bill of Supply business is told the BOS series, not an INV number", () => {
    const c = issueConsequences({ quote: { ...QUOTE, billOfSupply: true }, series: HEALTHY });
    expect(c.predictedIsCertain).toBe(false);
    expect(text(c)).toMatch(/Bill of Supply/);
    expect(text(c)).toMatch(/BOS-/);
    expect(text(c)).not.toContain("INV-TEST-27-0009");
  });

  it("adds nothing when the caller passes none of the new facts", () => {
    const before = text(issueConsequences({ quote: QUOTE, series: HEALTHY }));
    expect(before).not.toMatch(/Dated |GSTIN 0|including ₹|Bill of Supply/);
  });
});
