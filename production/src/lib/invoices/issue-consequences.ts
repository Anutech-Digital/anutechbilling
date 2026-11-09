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
import { isExportSupply, isZeroRatedSupply, overseasCountryMissing } from "@/lib/gst/place-of-supply";
import { fyCodeOfYear, fyLabel, fyStartYear } from "@/lib/dates/ist";
import { EXPORT_LUT_ENDORSEMENT, exportLutRefusal, lutFor, lutFyLabel, type TenantLut } from "@/lib/gst/export-lut";
import type { InvoiceDateWhy } from "./issue-date";


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
  /* ── R-2635: the export truth (R-2171 item 3). Each optional; left out, nothing is said. ── */
  /** Why `invoiceDate` is that day (issue-date.ts). Absent = "(today)", as before. */
  invoiceDateWhy?: InvoiceDateWhy;
  /** The customer's country. Empty = India (money-rules G5). `undefined` = not loaded. */
  customerCountry?: string | null;
  /** The customer's GST treatment (sez_without_payment is zero-rated too, R-2515). */
  customerTreatment?: string | null;
  /** The company's LUTs per FY (R-2444). `undefined` = not loaded → no ARN is claimed. */
  luts?: readonly TenantLut[] | null;
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
  /* R-2635: next_document_number takes the FY from the invoice DATE — a receipt-dated invoice of an
     earlier FY takes that year's series, not the series row passed in (this FY's). */
  const otherFy = !bos && series !== null && quote.invoiceDate !== undefined
    && series.fiscalYear !== fyCodeOfYear(fyStartYear(quote.invoiceDate));
  const predictedNumber = bos
    ? "Bill of Supply"
    : otherFy
      ? `the next number of the FY ${fyLabel(quote.invoiceDate as string)} series`
      : series
        ? formatDocumentNumber(series, next)
        : `${quote.id} → the first invoice of this financial year`;

  /* Most consequential first, because this is read in a hurry. The two facts that
     were not on screen at all before are the two at the top. */
  out.push({
    tone: "fact",
    text: bos
      ? "Issued as a Bill of Supply (your company is not GST-registered), with the next BOS- number. That number is used up either way — deleting it later retires it rather than freeing it."
      : otherFy
        ? `Takes ${predictedNumber} (the invoice is dated in that year). That number is used up either way — deleting the invoice later retires it rather than freeing it.`
        : series
          ? `Takes invoice number ${predictedNumber}. That number is used up either way — deleting the invoice later retires it rather than freeing it.`
          : `This is the first invoice of the financial year for this business, so it opens the series.`,
  });

  if (quote.invoiceDate) {
    /* R-2635: generate_invoice dates it on the latest receipt's day (R-2095), never inside locked
       books — the confirm said "(today)" for a quote paid weeks ago. */
    const why = quote.invoiceDateWhy === "receipt"
      ? " — the day the money came in (the latest receipt), not today"
      : quote.invoiceDateWhy === "books_lock"
        ? " — the first day after your locked books"
        : " (today)";
    out.push({
      tone: "fact",
      text: `Dated ${formatDate(quote.invoiceDate)}${why}. The date cannot be changed afterwards.`,
    });
  }

  /* R-2635 (R-2171 item 3): a customer abroad (or an SEZ unit supplied without payment of tax) is a
     zero-rated supply under the LUT of the invoice date's FY (R-2444, R-2515) — never "B2C". Same
     rules the server applies (supply_is_zero_rated, trg_invoices_zz_export_lut). */
  const zeroRated = !bos && quote.customerCountry !== undefined
    && isZeroRatedSupply({ country: quote.customerCountry, treatment: quote.customerTreatment ?? null });
  if (zeroRated) out.push(zeroRatedLine(quote));
  /* R-2620: Overseas with no country reads as India — the server refuses this invoice; never "B2C". */
  const overseasNoCountry = !bos && quote.customerCountry !== undefined
    && overseasCountryMissing({ treatment: quote.customerTreatment ?? null, country: quote.customerCountry });
  if (overseasNoCountry) {
    out.push({
      tone: "warning",
      text: `${quote.customerName || "This customer"} is marked Overseas but has no country, so nothing can be issued yet — ` +
        "the app cannot tell a 0% export from an Indian sale. Open the customer, pick its country, then issue.",
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
  if (quote.customerGstin !== undefined && !quote.customerGstin?.trim() && !zeroRated && !overseasNoCountry) {
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
    predictedIsCertain: !bos && series !== null && !otherFy,
    consequences: out,
  };
}

/** R-2635: the one line for a zero-rated (export / SEZ without payment) invoice. */
function zeroRatedLine(quote: QuoteToInvoice): Consequence {
  const who = quote.customerName || "this customer";
  const country = (quote.customerCountry ?? "").trim();
  const exportSale = isExportSupply(quote.customerCountry);
  const what = exportSale
    ? `an export invoice to ${who} (${country})`
    : `a zero-rated SEZ invoice (without payment of tax) to ${who}`;
  /* R-2636: generate_invoice REFUSES an export whose quote charges GST (never CGST+SGST, never
     re-priced) — so the warning says "nothing can be issued" and ConfirmIssueDialog holds Issue. */
  if (exportSale && quote.taxAmount != null && quote.taxAmount > 0) {
    return {
      tone: "warning",
      text: `This is ${what}, but the quote charges ${rupee(quote.taxAmount)} GST — not 0% under your LUT — so nothing can be issued: ` +
        `an export invoice is never CGST+SGST, and the amount the customer agreed to is not changed. ` +
        `Make a new quote for this customer at 0% GST (its country sets 0%) and issue that one instead.`,
    };
  }
  /* SEZ without payment: a quote that still charges GST is invoiced with it (IGST — SEZ is always inter-state). */
  if (quote.taxAmount != null && quote.taxAmount > 0) {
    return {
      tone: "warning",
      text: `This is ${what}, but the quote charges ${rupee(quote.taxAmount)} GST, so the invoice will too — not 0% under your LUT. ` +
        `To bill it at 0%, make a new quote for this customer (its SEZ without payment treatment sets 0%) and issue that one instead.`,
    };
  }
  const date = quote.invoiceDate ?? null;
  const known = date !== null && quote.luts !== undefined;
  const refusal = known ? exportLutRefusal(quote.luts, date) : null;
  if (refusal) {
    /* The server (trg_invoices_zz_export_lut) refuses it — so the Issue button is held
       (ConfirmIssueDialog blocks a warning that says "nothing can be issued"). */
    const words = exportSale ? refusal : refusal.replace(/An export( sale)? at 0% GST/g, "A 0% SEZ supply");
    return { tone: "warning", text: `This is ${what} at 0% GST, so nothing can be issued until the LUT is on file. ${words}` };
  }
  const lut = known ? lutFor(quote.luts, date) : null;
  const under = `0% GST${lut && date ? ` under LUT ${lut.arn} (FY ${lutFyLabel(date)})` : " under your LUT"}`;
  return {
    tone: "fact",
    text: isExportSupply(quote.customerCountry)
      ? `Issued as ${what}: ${under}, with the line "${EXPORT_LUT_ENDORSEMENT}". No GSTIN is needed for a buyer abroad.`
      : `Issued as ${what}: ${under}.`,
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
