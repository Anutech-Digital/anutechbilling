/**
 * R-2542 — which invoices take a receipt with NO quote.
 *
 * A payment is keyed by its quote (record_payment / record_desk_payment). Two kinds of invoice have
 * none and still take a receipt that carries the invoice itself (trg_payments_opening_invoice,
 * _record_opening_invoice_payment, record_multi_invoice_payment, bank_credit_pay_item):
 *   - a Zoho opening invoice (R-1739, document_kind 'opening_invoice');
 *   - an FY sale imported from Zoho (R-2499, invoices.zoho_invoice_id — never a quote; R-2501).
 * Before R-2542 the app's screens only knew the first: an imported FY sale (2,353 on staging) could not
 * be paid from Invoices → Record payment, Payments → several invoices, or the bank Reconcile sheet.
 *
 * This mirrors the SQL rule exactly — keep the two in step.
 */
import { isOpeningInvoice } from "@/lib/accounting/sale-documents";

export interface QuotelessReceiptFields {
  document_kind?: string | null;
  quote_id?: string | null;
  /** invoices.zoho_invoice_id (R-2499) — read with select("*"); not in the generated row type yet. */
  zoho_invoice_id?: string | null;
}

/** True when the invoice's receipt is recorded on the invoice itself (no quote). */
export function takesQuotelessReceipt(inv: QuotelessReceiptFields | null | undefined): boolean {
  if (!inv) return false;
  if (isOpeningInvoice(inv)) return true;
  return !inv.quote_id && !!inv.zoho_invoice_id;
}

/** The fields the several-invoices sheet's open-invoice list decides on. */
export interface MultiPayCandidate extends QuotelessReceiptFields {
  id: string;
}

/**
 * Which of a customer's open invoices the several-invoices sheet lists (useCustomerOpenInvoices):
 *  - a quote's OWN invoice (the quote's invoice_id is this invoice) — record_desk_payment;
 *  - the oldest open instalment of each subscription (R-1564) — record_instalment_payment;
 *  - an invoice that takes a quote-less receipt (R-1739 opening, R-2542 Zoho FY sale).
 * Anything else (a project invoice, a hand-made invoice with no quote) has no path here.
 */
export function multiPayListed<T extends MultiPayCandidate>(
  invoices: readonly T[],
  ownQuoteInvoice: ReadonlySet<string>,
  oldestInstalments: ReadonlySet<string>,
): Array<T & { instalment?: true }> {
  return invoices
    .filter((i) =>
      takesQuotelessReceipt(i)
      || (i.quote_id ? ownQuoteInvoice.has(`${i.quote_id}|${i.id}`) : oldestInstalments.has(i.id)))
    .map((i) => (oldestInstalments.has(i.id) ? { ...i, instalment: true as const } : i));
}
