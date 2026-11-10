/**
 * R-2647 — a pending row of the /invoices list in the shape issueConsequences needs.
 *
 * R-2635/R-2636 gave the quote page's "Generate GST Invoice" confirm the export truth (0% under the
 * LUT of the invoice date's FY, or WITH payment of IGST when the quote charges GST) and the real
 * invoice date. The /invoices list "Generate" opened the SAME dialog with only name, amount, terms
 * and GSTIN — so a customer abroad read "goes out as a B2C invoice" and no date was shown. This maps
 * the same facts the quote page passes, so both confirms say the same words from the one helper.
 *
 * Pure and display-only: generate_invoice decides everything.
 */
import type { QuoteToInvoice } from "./issue-consequences";
import type { InvoiceDateWhy } from "./issue-date";
import type { PendingPartAction } from "./split-sale-pending";
import type { TenantLut } from "@/lib/gst/export-lut";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { taxableAfterDiscount } from "@/lib/quotes/amounts";

/** What useQuotesAwaitingInvoice returns per row (only the fields used here). */
export interface PendingQuoteForIssue {
  id: string;
  customer_name?: string | null;
  amount?: number | null;
  payment_terms_days?: number | null;
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
  /** Absent (undefined) = not asked; the reminder then stays silent. */
  customer_gstin?: string | null;
  /** The customer's country; empty = India (G5). `undefined` = not loaded → nothing said about export. */
  customer_country?: string | null;
  customer_treatment?: string | null;
  /** IST day of the latest received payment (generate_invoice dates on it), null when none. */
  latest_receipt_day?: string | null;
  part_action?: PendingPartAction;
}

/**
 * The GST inside the quote total, as the quote page shows it (R-804: stored total − taxable after
 * discount, when it agrees with the rate). No subtotal stored → worked back from the total and rate.
 */
function quoteGst(q: PendingQuoteForIssue): number | undefined {
  const rate = q.tax_rate ?? 0;
  if (q.subtotal != null) return quoteDisplayTax(taxableAfterDiscount(q.subtotal, q.discount_pct ?? 0), rate, q.amount);
  if (q.amount == null) return undefined;
  return q.amount - Math.round(q.amount / (1 + rate / 100));
}

export function pendingQuoteToIssuable(
  q: PendingQuoteForIssue,
  ctx?: {
    /** The server's date (invoice_date_for_receipt); undefined while loading → no date line. */
    invoiceDate?: string;
    invoiceDateWhy?: InvoiceDateWhy;
    /** undefined = not loaded → no ARN is claimed. */
    luts?: readonly TenantLut[] | null;
    /** The company is not GST-registered (R-1529) — a Bill of Supply, as on the quote page. */
    billOfSupply?: boolean;
  },
): QuoteToInvoice {
  const act = q.part_action;
  /* A part row (R-2057) is issued by its own "Generate invoice for Q1" button, not this confirm; its
     own GST is not on the row, so nothing is said about GST or export for it (never a 0% claim). */
  const part = act?.kind === "part" ? act : null;
  return {
    id: q.id,
    customerName: q.customer_name ?? null,
    /* R-2057: a part's invoice is for the part, not the year. */
    amount: part ? part.amount ?? q.amount ?? null : q.amount ?? null,
    taxAmount: part ? undefined : quoteGst(q),
    paymentTermsDays: q.payment_terms_days ?? null,
    /* undefined (lookup failed) stays undefined — no B2C warning about a GSTIN nobody read. */
    customerGstin: q.customer_gstin,
    customerCountry: part ? undefined : q.customer_country,
    customerTreatment: q.customer_treatment ?? null,
    invoiceDate: ctx?.invoiceDate,
    invoiceDateWhy: ctx?.invoiceDateWhy,
    luts: ctx?.luts,
    billOfSupply: ctx?.billOfSupply,
  };
}

/**
 * R-2651 — the selected rows for the bulk "Generate N" confirm, each with the same facts its single
 * confirm gets: the server's date for ITS latest receipt day (`dateFor`, from useInvoiceIssueDates),
 * the LUTs and Bill of Supply. A part row (R-2057) is billed by the billing job's own path, so no date
 * is claimed for it (and pendingQuoteToIssuable claims no export/GST for it).
 */
export function pendingQuotesToIssuable(
  rows: readonly PendingQuoteForIssue[],
  ctx: {
    /** undefined = that day's date not known (loading / failed) → no date line, no ARN. */
    dateFor: (receiptDay: string | null) => { date: string | null; why?: InvoiceDateWhy } | undefined;
    luts?: readonly TenantLut[] | null;
    billOfSupply?: boolean;
  },
): QuoteToInvoice[] {
  return rows.map((q) => {
    const d = q.part_action?.kind === "part" ? undefined : ctx.dateFor(q.latest_receipt_day ?? null);
    return pendingQuoteToIssuable(q, {
      invoiceDate: d?.date ?? undefined,
      invoiceDateWhy: d?.date ? d.why : undefined,
      luts: ctx.luts,
      billOfSupply: ctx.billOfSupply,
    });
  });
}
