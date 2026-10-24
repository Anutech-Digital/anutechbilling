/**
 * R-034 — a paid order must not download as a quotation.
 *
 * Pawan measured it on Q-2222-2026-27-0020 (₹708, paid): the PDF the customer gets
 * back from the DMS panel said "QUOTATION", carried a "Valid until" date and told them
 * "Net 7 days from acceptance". Three sentences asking for money that had arrived.
 *
 * The decision half is unit-tested here; the RENDERING half is a source scan, because
 * @react-pdf/renderer draws to a PDF buffer and no assertion about the visible words
 * survives that. Same reason `grid-flow-col-reset.test.ts` scans instead of rendering.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { quoteIsPaid, quoteDocumentLabel } from "./quote-document-kind";

type Q = Parameters<typeof quoteIsPaid>[0];
const q = (payment_status: string | null) => ({ payment_status } as unknown as Q);

describe("quoteIsPaid", () => {
  it("is paid once the money is in", () => {
    expect(quoteIsPaid(q("received"))).toBe(true);
    /* Invoiced AND the payments cover the quote: "Net 7 days" is as wrong here as on a
       `received` quote. ₹1 of rounding is tolerated. */
    expect(quoteIsPaid({ payment_status: "invoiced", amount: 11800, payment_amount: 11800 } as unknown as Q)).toBe(true);
    expect(quoteIsPaid({ payment_status: "invoiced", amount: 11800, payment_amount: 11799 } as unknown as Q)).toBe(true);
  });

  /* R-159 (Hitesh, Demo Co, 5 Oct 2026): "I converted a Quote into Invoice
     without payment. Why is it showing quote paid?" generate_invoice writes 'invoiced'
     whether or not money arrived — an invoice is not a payment. */
  it("is NOT paid when it was invoiced before the money came", () => {
    expect(quoteIsPaid({ payment_status: "invoiced", amount: 11800, payment_amount: 0 } as unknown as Q)).toBe(false);
    expect(quoteIsPaid({ payment_status: "invoiced", amount: 11800, payment_amount: null } as unknown as Q)).toBe(false);
    expect(quoteIsPaid({ payment_status: "invoiced", amount: 11800, payment_amount: 5000 } as unknown as Q)).toBe(false);
    expect(quoteIsPaid(q("invoiced"))).toBe(false); // no amounts known → never assume paid
  });

  it("is NOT paid while a balance is genuinely still due", () => {
    /* `partial` is the case this must not swallow: some of it really is owed, so the
       validity window and the payment terms are still the truth for that customer. */
    expect(quoteIsPaid(q("partial"))).toBe(false);
    expect(quoteIsPaid(q("awaiting"))).toBe(false);
    expect(quoteIsPaid(q(null))).toBe(false);
  });
});

describe("quoteDocumentLabel", () => {
  it("names an unpaid quote exactly as before", () => {
    expect(quoteDocumentLabel({ paid: false })).toBe("Quotation");
    expect(quoteDocumentLabel({ paid: false, isRenewal: true })).toBe("Renewal Quotation");
  });

  it("names a paid one as an ORDER, never as an invoice", () => {
    /* "Invoice" would put a second, unnumbered invoice-shaped document in the
       customer's hands next to the real GST one (§17a — the series is gapless and
       this sheet has no number in it). */
    expect(quoteDocumentLabel({ paid: true })).toBe("Paid order");
    expect(quoteDocumentLabel({ paid: true, isRenewal: true })).toBe("Renewal order · Paid");
    expect(quoteDocumentLabel({ paid: true })).not.toMatch(/invoice/i);
    expect(quoteDocumentLabel({ paid: true })).not.toMatch(/quotation/i);
  });
});

/** Comments stripped: prose explaining a removed sentence must not satisfy a scan for it (L46). */
const pdf = readFileSync("src/lib/pdf/QuotePDF.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("QuotePDF drops the three sentences that ask for money", () => {
  it("takes its heading from the shared helper, not from its own ternary", () => {
    expect(pdf).toContain("quoteDocumentLabel({ paid: isPaid, isRenewal })");
    // The old inline decision is gone, so the header and the footer cannot drift.
    expect(pdf).not.toMatch(/isRenewal \? "Renewal Quotation" : "Quotation"/);
  });

  it('gates "Valid until" behind !isPaid', () => {
    expect(pdf).toMatch(/\{!isPaid && \(\s*<Text style=\{s\.quoteDate\}>Valid until:/);
  });

  it("gates the Net-7 terms and the validity line behind !isPaid", () => {
    /* R-1670 (3): the terms line is the quote's own terms now (payment-terms.ts), not "Net 7". */
    expect(pdf).toContain("quotePaymentTermsLine(paymentTermsDays)");
    expect(pdf).toContain("Received in full");
    // Both money-asking lines are gated on !isPaid; the paid sentence on isPaid.
    expect(pdf).toMatch(/\{isPaid && \(\s*<Text style=\{s\.footerLine\}>/);
    expect((pdf.match(/\{!isPaid && \(\s*<Text style=\{s\.footerLine\}>/g) ?? []).length).toBe(2);
  });
});

describe("the prop builders decide it once", () => {
  it.each([
    ["src/lib/pdf/build-props.ts",          "server builder (/api/v1, email, cron)"],
    ["src/app/(app)/quotes/[id]/page.tsx",  "in-app Download PDF button"],
  ])("%s (%s) passes isPaid from quoteIsPaid", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("quoteIsPaid(quote)");
  });
});
