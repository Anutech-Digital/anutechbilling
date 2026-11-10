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
  part_action?: PendingPartAction;
}

export function pendingQuoteToIssuable(
  q: PendingQuoteForIssue,
  ctx?: {
    /** The server's date (invoice_date_for_receipt); undefined while loading → no date line. */
    invoiceDate?: string;
    invoiceDateWhy?: InvoiceDateWhy;
    /** undefined = not loaded → no ARN is claimed. */
    luts?: readonly TenantLut[] | null;
  },
): QuoteToInvoice {
  const part = q.part_action?.kind === "part";
  /* Same as the quote page: GST = stored total − taxable after discount (R-804), when it agrees. */
  const subtotal = q.subtotal ?? null;
  const taxable = subtotal === null ? null : subtotal - Math.round(subtotal * ((q.discount_pct ?? 0) / 100));
  const taxAmount = part || taxable === null ? undefined : quoteDisplayTax(taxable, q.tax_rate ?? 0, q.amount);
  return {
    id: q.id,
    customerName: q.customer_name ?? null,
    /* R-2057: a part's invoice is for the part, not the year. */
    amount: part && q.part_action?.kind === "part" ? q.part_action.amount ?? q.amount ?? null : q.amount ?? null,
    /* A part's own GST is not on the row — say no GST figure rather than the year's. */
    taxAmount,
    paymentTermsDays: q.payment_terms_days ?? null,
    customerGstin: q.customer_gstin ?? null,
    /* A part row has no GST figure here, so it would be judged as 0% — say nothing about export for it
       (parts are issued through the bulk confirm, which states no export line). */
    customerCountry: part ? undefined : q.customer_country,
    customerTreatment: q.customer_treatment ?? null,
    invoiceDate: ctx?.invoiceDate,
    invoiceDateWhy: ctx?.invoiceDateWhy,
    luts: ctx?.luts,
  };
}
