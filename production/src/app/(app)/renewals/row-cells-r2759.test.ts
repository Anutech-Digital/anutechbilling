/** R-2759 (R-2739b): the two-line table cells' pure words. */
import { describe, expect, it } from "vitest";
import { dueSubWords, lastInvoiceOf, nextTermWords } from "./row-cells";
import type { LastDocs, LastInvoice } from "./last-docs";

const inv = (id: string): LastInvoice => ({
  id, date: "2026-11-01", status: "sent", amount: 1180, paidAmount: 0, currency: "INR", dueDate: null, netPayable: 1180,
  adjustedAdvances: null, writtenOffAt: null, fxRate: null, sourceQuoteId: null, part: null, period: null, notes: null,
});
const docs = (invoices: LastInvoice[]): LastDocs => ({ quote: null, invoice: invoices[0] ?? null, invoices, sent: null });

describe("R-2759 row cells", () => {
  it("the next term's period: inclusive renewal_date → the day after, for term_months", () => {
    expect(nextTermWords({ renewal_date: "2026-11-30", start_date: "2025-12-01", term_months: 12 })).toBe("1 Dec 2026 – 30 Nov 2027");
  });
  it("anniversary renewal_date starts the term on that day; 3-year terms say so", () => {
    expect(nextTermWords({ renewal_date: "2027-02-14", start_date: "2024-02-14", term_months: 36 })).toBe("14 Feb 2027 – 13 Feb 2030 (3 yr)");
  });
  it("no renewal date → nothing", () => {
    expect(nextTermWords({ renewal_date: null })).toBeNull();
  });
  it("due words under the date", () => {
    expect(dueSubWords(6)).toBe("in 6d");
    expect(dueSubWords(0)).toBe("today");
    expect(dueSubWords(-11)).toBe("11d ago");
    expect(dueSubWords(null)).toBeNull();
  });
  it("Last invoice: the newest one + the earlier count (R-2748 reads two)", () => {
    const r = lastInvoiceOf(docs([inv("INV-2"), inv("INV-1")]));
    expect(r.invoice?.id).toBe("INV-2");
    expect(r.earlier.map((i) => i.id)).toEqual(["INV-1"]);
    expect(lastInvoiceOf(undefined)).toEqual({ invoice: null, earlier: [] });
  });
});
