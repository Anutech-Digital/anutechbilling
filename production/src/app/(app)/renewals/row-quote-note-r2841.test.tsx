// @vitest-environment jsdom
/* R-2841 (renewals history audit H6): the table row / card shows a quote NEWER than the last invoice
   that the Status chip does not name (an accepted add-seats quote not invoiced yet) — and nothing in
   every other case (one fact one place). Rule: last-docs.ts rowQuoteNote. */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { CARD_CHIP, cardDocQuote, rowQuoteNote, type LastDocs, type LastInvoice, type LastQuote } from "./last-docs";
import { LastInvoiceCell } from "./row-cells";
import { LastDocsLines } from "./last-docs-cell";

afterEach(cleanup);

const TODAY = "2026-11-15";
const inv = (id: string, date: string, sourceQuoteId: string | null = null): LastInvoice => ({
  id, date, status: "paid", amount: 1180, paidAmount: 1180, currency: "INR", dueDate: null, netPayable: 1180,
  adjustedAdvances: null, writtenOffAt: null, fxRate: null, sourceQuoteId, part: null, period: null, notes: { credit: 0, debit: 0 },
});
const quote = (id: string, date: string, over: Partial<LastQuote> = {}): LastQuote => ({
  id, date, status: "accepted", payment_status: "none", expires_date: null, invoice_id: null, part: null, period: null, ...over,
});
const docs = (q: LastQuote | null, invoices: LastInvoice[]): LastDocs => ({ quote: q, invoice: invoices[0] ?? null, invoices, sent: null });

const addSeats = quote("Q-ADD-1", "2026-11-10");
const paidInv = inv("INV-9", "2026-10-01", "Q-REN-1");

describe("rowQuoteNote (R-2841)", () => {
  it("1. newest quote is newer than the last invoice, not its quote, not the chip's → shown", () => {
    expect(rowQuoteNote(docs(addSeats, [paidInv]), { quoteId: null, key: "due" })?.id).toBe("Q-ADD-1");
    expect(rowQuoteNote(docs(addSeats, [paidInv]), { quoteId: "Q-OTHER", key: "sent", quoteStatus: "sent" })?.id).toBe("Q-ADD-1");
  });
  it("2. quote older than the last invoice → nothing", () => {
    expect(rowQuoteNote(docs(quote("Q-OLD", "2026-09-01"), [paidInv]), CARD_CHIP)).toBeNull();
  });
  it("3. quote is the invoice's own source quote (or already invoiced) → nothing", () => {
    const src = quote("Q-REN-1", "2026-11-12");
    expect(rowQuoteNote(docs(src, [paidInv]), CARD_CHIP)).toBeNull();
    /* an earlier shown invoice's quote too */
    expect(rowQuoteNote(docs(src, [inv("INV-10", "2026-10-05"), paidInv]), CARD_CHIP)).toBeNull();
    /* invoiced into an invoice the row does not show — billed, its invoice says it */
    expect(rowQuoteNote(docs(quote("Q-X", "2026-11-12", { invoice_id: "INV-77" }), [paidInv]), CARD_CHIP)).toBeNull();
  });
  it("4. the Status chip already names the quote → nothing", () => {
    expect(rowQuoteNote(docs(addSeats, [paidInv]), { quoteId: "Q-ADD-1", key: "sent", quoteStatus: "accepted" })).toBeNull();
  });
  it("no invoice / no quote → nothing (the no-invoice row already shows its quote)", () => {
    expect(rowQuoteNote(docs(addSeats, []), CARD_CHIP)).toBeNull();
    expect(rowQuoteNote(docs(null, [paidInv]), CARD_CHIP)).toBeNull();
    expect(rowQuoteNote(undefined, CARD_CHIP)).toBeNull();
  });
  it("same day as the invoice and not invoiced → shown; invoice with no date → shown", () => {
    expect(rowQuoteNote(docs(quote("Q-S", "2026-10-01"), [paidInv]), CARD_CHIP)?.id).toBe("Q-S");
    expect(rowQuoteNote(docs(addSeats, [{ ...paidInv, date: null }]), CARD_CHIP)?.id).toBe("Q-ADD-1");
  });
});

describe("rowQuoteNote — review fixes (R-2841)", () => {
  it("stage not read yet → nothing (never shows, then vanishes)", () => {
    expect(rowQuoteNote(docs(addSeats, [paidInv]), null)).toBeNull();
  });
  it("only a chip that NAMES the quote hides it: a stopped / ending row, or an unread quote, does not", () => {
    expect(rowQuoteNote(docs(addSeats, [paidInv]), { quoteId: "Q-ADD-1", key: "stopped", quoteStatus: "accepted" })?.id).toBe("Q-ADD-1");
    expect(rowQuoteNote(docs(addSeats, [paidInv]), { quoteId: "Q-ADD-1", key: "sent", quoteStatus: "unknown" })?.id).toBe("Q-ADD-1");
  });
  it("invoiced through invoices.quote_id on an invoice the row does not show → nothing", () => {
    expect(rowQuoteNote({ ...docs(addSeats, [paidInv]), invoicedQuoteIds: ["Q-ADD-1"] }, CARD_CHIP)).toBeNull();
    expect(rowQuoteNote(docs(quote("Q-Y", "2026-11-12", { payment_status: "invoiced" }), [paidInv]), CARD_CHIP)).toBeNull();
  });
  it("an older shape with only `invoice` set counts as an invoice", () => {
    expect(rowQuoteNote({ quote: quote("Q-OLD", "2026-09-01"), invoice: paidInv, invoices: [], sent: null }, CARD_CHIP)).toBeNull();
  });
  it("cardDocQuote: beside an invoice by the rule, else the only document", () => {
    expect(cardDocQuote(docs(addSeats, [paidInv]))?.id).toBe("Q-ADD-1");
    expect(cardDocQuote(docs(quote("Q-OLD", "2026-09-01"), [paidInv]))).toBeNull();
    expect(cardDocQuote(docs(addSeats, []))?.id).toBe("Q-ADD-1");
  });
});

const cellProps = { loading: false, failed: false, canInvoices: true, canQuotes: true, todayIst: TODAY };

describe("table cell + card lines (R-2841)", () => {
  it("table: the invoice stays, a muted linked quote line is added", () => {
    render(<LastInvoiceCell {...cellProps} docs={docs(addSeats, [paidInv])} stage={{ quoteId: null, key: "due" }} />);
    const line = screen.getByTestId("renewal-row-quote-note");
    expect(line.textContent).toBe("Quote Q-ADD-1Accepted");
    expect(screen.getByRole("link", { name: "Q-ADD-1" }).getAttribute("href")).toBe("/quotes/Q-ADD-1");
    expect(screen.getByTestId("renewal-last-invoice-status").textContent).toBe("Paid");
  });
  it("table: a 'Quote sent' chip that names the quote → no quote line", () => {
    render(<LastInvoiceCell {...cellProps} docs={docs(addSeats, [paidInv])} stage={{ quoteId: "Q-ADD-1", key: "sent", quoteStatus: "accepted" }} />);
    expect(screen.queryByTestId("renewal-row-quote-note")).toBeNull();
  });
  it("table: stage still loading → no quote line", () => {
    render(<LastInvoiceCell {...cellProps} docs={docs(addSeats, [paidInv])} stage={null} />);
    expect(screen.queryByTestId("renewal-row-quote-note")).toBeNull();
  });
  it("table: no quotes permission → the number without a link", () => {
    render(<LastInvoiceCell {...cellProps} canQuotes={false} docs={docs(addSeats, [paidInv])} stage={CARD_CHIP} />);
    expect(screen.getByTestId("renewal-row-quote-note").textContent).toBe("Quote Q-ADD-1Accepted");
    expect(screen.queryByRole("link", { name: "Q-ADD-1" })).toBeNull();
  });
  it("card: the newer not-invoiced quote shows beside the invoice (its chip names no quote number)", () => {
    render(<LastDocsLines {...cellProps} docs={docs(addSeats, [paidInv])} />);
    expect(document.querySelector('[data-doc-line="quote"]')).toBeTruthy();
  });
  it("card: an older quote beside a newer invoice is not repeated", () => {
    render(<LastDocsLines {...cellProps} docs={docs(quote("Q-OLD", "2026-09-01"), [paidInv])} />);
    expect(document.querySelector('[data-doc-line="quote"]')).toBeNull();
  });
  it("card: no invoice → the quote line stays (it is the only document)", () => {
    render(<LastDocsLines {...cellProps} docs={docs(addSeats, [])} />);
    expect(document.querySelector('[data-doc-line="quote"]')).toBeTruthy();
  });
});
