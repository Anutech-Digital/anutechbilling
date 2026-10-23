/**
 * What becomes irreversible when an invoice is issued, in the operator's words.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Issuing a GST tax invoice was a single unconfirmed click. `/invoices` had a
 * "Generate" button wired straight to `generateInvoice.mutate(q.id)`, and a BULK
 * action that looped it over every selected quote — so one click could burn a run
 * of serial numbers. Nothing on screen said what the click did.
 *
 * Two things make that worse than it looks:
 *
 *   1. Since 20260823090000 an issued invoice genuinely CANNOT be edited. Before
 *      that guard the click was recoverable by a quiet UPDATE; now the only
 *      correction is a credit note plus a fresh invoice (CGST Section 34). The
 *      screen must say so before the click, not after.
 *   2. The serial number is consumed and never reused. `invoice_delete_no_serial_reuse`
 *      (migration 0118) retires a deleted invoice's number, because CGST Rule 46
 *      forbids two supplies sharing one. So a mistaken issue leaves a permanent hole.
 *
 * ─── AND IT SHOWS THE NUMBER, WHICH IS ITS OWN ALARM ────────────────────────
 * Measured 23 Aug 2026: ANUTECH has **zero** invoices and its FY2627 series sits at
 * **32**. Thirty-two numbers consumed, every one of those invoices since deleted. An
 * operator who has never issued an invoice, shown "this will take
 * INV-ADPL-2026-27-0033", learns something no summary would have told them. That is
 * the point of naming the number rather than saying "a number will be used".
 *
 * Pure and display-only: it decides nothing and writes nothing. `next_document_number`
 * remains the only thing that allocates, so the predicted number is a PREDICTION —
 * a concurrent issue can take it first, and `predictedIsCertain` says as much.
 */
import { rupee, formatDate } from "@/lib/utils";
import {
  formatDocumentNumber, seriesGap,
  type Consequence, type SeriesState,
} from "@/lib/actions/consequence";


export interface QuoteToInvoice {
  id: string;
  customerName: string | null;
  /** Whole rupees (CLAUDE.md §13). */
  amount: number | null;
  /** Net-30 fallback applies when the quote carries none — see 20260822190000. */
  paymentTermsDays: number | null;
  /**
   * The BUYER's GSTIN, or null when they have none on file.
   *
   * Null is a perfectly valid invoice — see the reminder this drives below. It is on
   * the quote's customer, not on the quote.
   */
  customerGstin?: string | null;
  /* ── R-1633: facts the one-click paths (quote page, project milestone) show. Each is
     optional; left out, nothing is said about it (the /invoices list passes none). ── */
  /** The GST inside `amount`, whole rupees — "₹1,18,000 including ₹18,000 GST". */
  taxAmount?: number | null;
  /** The date the document will carry (IST today), "YYYY-MM-DD". */
  invoiceDate?: string;
  /** A fixed due date (a project milestone's own), replacing the payment-terms line. */
  dueDate?: string | null;
  /** The company is not GST-registered (R-1529): a Bill of Supply from the BOS- series. */
  billOfSupply?: boolean;
}


export interface IssueConsequences {
  /** The number this will most likely take, e.g. "INV-ADPL-2026-27-0033". */
  predictedNumber: string;
  /**
   * False when the prediction could be wrong — the series row is missing, so the
   * number is being guessed rather than read. Never claim certainty this cannot have.
   */
  predictedIsCertain: boolean;
  /** Ordered most-consequential first. */
  consequences: Consequence[];
}


export function issueConsequences(args: {
  quote: QuoteToInvoice;
  /** Null when the tenant has no series row yet — the first invoice of the year. */
  series: SeriesState | null;
}): IssueConsequences {
  const { quote, series } = args;
  const out: Consequence[] = [];

  const next = (series?.lastNumber ?? 0) + 1;
  /* R-1633: a business that is not GST-registered issues a Bill of Supply from its own
     BOS- series (R-1529, next_document_number). The INV counter says nothing about that
     series, so no number is predicted — the series is named instead. */
  const bos = quote.billOfSupply === true;
  const predictedNumber = bos
    ? "Bill of Supply"
    : series
      ? formatDocumentNumber(series, next)
      : `${quote.id} → the first invoice of this financial year`;

  /* Most consequential first, because this is read in a hurry. The two facts that
     were not on screen at all before are the two at the top. */
  out.push({
    tone: "fact",
    text: bos
      ? "Issued as a Bill of Supply (your company is not GST-registered), with the next BOS- number. That number is used up either way — deleting it later retires it rather than freeing it."
      : series
        ? `Takes invoice number ${predictedNumber}. That number is used up either way — deleting the invoice later retires it rather than freeing it.`
        : `This is the first invoice of the financial year for this business, so it opens the series.`,
  });

  if (quote.invoiceDate) {
    out.push({
      tone: "fact",
      text: `Dated ${formatDate(quote.invoiceDate)} (today). The date cannot be changed afterwards.`,
    });
  }

  const gstin = quote.customerGstin?.trim();
  if (gstin) {
    out.push({
      tone: "fact",
      text: `Billed to ${quote.customerName || "this customer"}, GSTIN ${gstin} — check it: the buyer's input credit depends on it.`,
    });
  }

  out.push({
    tone: "fact",
    text: "Once issued it cannot be edited. Correcting a mistake means a credit note plus a fresh invoice, not a change to this one.",
  });

  if (quote.amount !== null && quote.amount > 0) {
    out.push({
      tone: "fact",
      text: `${rupee(quote.amount)}${quote.taxAmount != null && quote.taxAmount > 0 ? ` including ${rupee(quote.taxAmount)} GST` : ""} becomes payable${quote.customerName ? ` by ${quote.customerName}` : ""}, on a document you cannot alter afterwards.`,
    });
  } else {
    /* generate_invoice refuses a ₹0 quote (#26), so this is a block, not a caveat. */
    out.push({
      tone: "warning",
      text: "This quote has no amount, so no invoice can be issued from it. Set the quote total first.",
    });
  }

  /* Payment terms. The net-30 fallback landed on 22 Aug 2026; before it, a quote with
     no terms produced an invoice due the day it was issued, and the dunning cron began
     chasing the next morning. Worth stating which of the two applies. */
  if (quote.dueDate) {
    out.push({ tone: "fact", text: `Falls due on ${formatDate(quote.dueDate)}.` });
  } else if (quote.paymentTermsDays === null) {
    out.push({
      tone: "fact",
      text: "The quote carries no payment terms, so the invoice falls due 30 days from today.",
    });
  } else if (quote.paymentTermsDays <= 0) {
    out.push({
      tone: "warning",
      text: "The quote's payment terms are 0 days, so this invoice is due the moment it is issued and will be chased as overdue tomorrow.",
    });
  } else {
    out.push({
      tone: "fact",
      text: `Falls due in ${quote.paymentTermsDays} days, from the quote's own payment terms.`,
    });
  }

  /* ── THE BUYER'S GSTIN — A REMINDER, NEVER A BLOCK ───────────────────────
     Asked for by Pardeep on 30 Aug 2026, and he framed it exactly right: a GSTIN is
     not needed to QUOTE, and it is not compulsory on an invoice either, "kyoki kai
     logo ke pass gst number hota hi nahi".

     He is right in law as well as in practice. CGST Rule 46(b)/(f) asks for the
     recipient's GSTIN **where the recipient is registered**; a supply to an
     unregistered person is a valid B2C tax invoice without one. Refusing to issue
     would block a whole class of real customers.

     But it matters, and only in one direction: a registered buyer whose GSTIN is
     missing from the invoice **cannot claim the input tax credit**, and the invoice
     cannot be edited afterwards (see the second consequence above). The correction is
     a credit note and a fresh invoice. That is worth one line before the click, and
     nothing after it.

     `undefined` — the caller did not tell us — says nothing rather than guessing.
     Silence is right there: a made-up warning on every invoice is a warning nobody
     reads, and this one has to be readable on the day it is true. */
  if (quote.customerGstin !== undefined && !quote.customerGstin?.trim()) {
    out.push({
      tone: "warning",
      text:
        `No GSTIN on file for ${quote.customerName || "this customer"}, so this goes out as a B2C invoice. ` +
        `That is valid — but if they ARE GST-registered, add it before issuing: without it they cannot claim ` +
        `input credit, and an issued invoice cannot be corrected except by a credit note.`,
    });
  }

  /* The series-gap alarm, from the shared helper — the receipt-voucher and quote
     counters have the same holes, so the wording lives in one place. */
  const gap = bos ? null : seriesGap(series, "invoice");
  if (gap) out.push(gap);

  return {
    predictedNumber,
    predictedIsCertain: !bos && series !== null,
    consequences: out,
  };
}

/**
 * The same question for a BULK issue, which is the one that can do real damage: the
 * old bulk button looped `generateInvoice` over every selected quote with no
 * confirmation at all, so one click could consume a run of numbers.
 */
export function bulkIssueConsequences(args: {
  quotes: readonly QuoteToInvoice[];
  series: SeriesState | null;
}): IssueConsequences {
  const { quotes, series } = args;
  const n = quotes.length;
  const total = quotes.reduce((s, q) => s + (q.amount ?? 0), 0);

  const first = (series?.lastNumber ?? 0) + 1;
  const last = first + Math.max(0, n - 1);
  const range = series
    ? n === 1
      ? formatDocumentNumber(series, first)
      : `${formatDocumentNumber(series, first)} … ${formatDocumentNumber(series, last)}`
    : "the first numbers of this financial year";

  const out: Consequence[] = [
    {
      tone: "fact",
      text: `Issues ${n} invoice${n === 1 ? "" : "s"} and uses ${n === 1 ? "number" : "numbers"} ${range}.`,
    },
    {
      tone: "fact",
      text: "None of them can be edited afterwards. Each mistake needs its own credit note.",
    },
    {
      tone: total > 0 ? "fact" : "warning",
      text: total > 0
        ? `${rupee(total)} becomes payable across ${n} customer document${n === 1 ? "" : "s"}.`
        : "None of the selected quotes carries an amount, so nothing can be issued.",
    },
  ];

  /* The bulk path is partial-failure-prone: the old loop counted ok/fail and carried
     on, so a run could stop halfway with numbers already consumed. Saying so is the
     difference between "it failed" and "it half-succeeded and you now have gaps". */
  if (n > 1) {
    out.push({
      tone: "warning",
      text: "These are issued one at a time. If one fails partway, the invoices before it are already issued and their numbers already used.",
    });
  }

  return { predictedNumber: range, predictedIsCertain: series !== null, consequences: out };
}
