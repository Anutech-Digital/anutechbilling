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

describe("R-2759 code-review fixes", () => {
  it("short term for the table line", async () => {
    const { nextTermShort } = await import("./row-cells");
    expect(nextTermShort({ renewal_date: "2026-11-30", start_date: "2025-12-01", term_months: 12 })).toBe("1 Dec 26 – 30 Nov 27");
  });
  it("compact chip: the period leaves the chip (Product & period says it); day count / amount is line 2", async () => {
    const { compactStage } = await import("./row-cells");
    expect(compactStage({ key: "sent", label: "Renewal quote sent · 1 Dec 2026 – 30 Nov 2027", note: "Overdue 3d" }))
      .toEqual({ chip: "Quote sent", line2: "Overdue 3d" });
    expect(compactStage({ key: "quote-closed", label: "Renewal quote expired", note: "Due in 4d" }).chip).toBe("Quote expired");
    expect(compactStage({ key: "draft", label: "Draft part quote · Dec 2026", note: null }).chip).toBe("Draft quote");
    expect(compactStage({ key: "invoiced", label: "Invoiced · ₹23,010 overdue 43d", note: "Oct 2026" }))
      .toEqual({ chip: "Invoiced", line2: "₹23,010 overdue 43d" });
    expect(compactStage({ key: "ending", label: "Won't renew · ends 24 Nov 2026", note: null }))
      .toEqual({ chip: "Won't renew", line2: "ends 24 Nov 2026" });
    expect(compactStage({ key: "due", label: "Due in 6d", note: null })).toEqual({ chip: "Due in 6d", line2: null });
  });
});
