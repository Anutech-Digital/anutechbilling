/**
 * R-1739 — which invoices are OUR sales.
 *
 * An invoice imported from Zoho Books (Invoices → Import from Zoho) has
 * `document_kind = 'opening_invoice'`. It is only an open balance the customer still owes:
 * its GST was filed (GSTR-1 / 3B) and its revenue booked in Zoho Books, and its number is
 * Zoho's, not our series. So it is in dues, aging, statements, reminders and payments — and
 * NEVER in a GST report, the P&L / revenue, e-invoicing (IRN), the day book's Sales, Tally
 * sales vouchers, or "invoiced this month".
 *
 * This file is the ONE rule every TypeScript GST / revenue reader uses; its SQL twin is
 * `public.invoice_is_sale(document_kind)` (migration 20261022013149). The guard test
 * `sale-documents.guard.test.ts` lists every reader of the invoices table and fails when a
 * new one appears that has not said whether it is a sales reader.
 */

export const OPENING_INVOICE_KIND = "opening_invoice" as const;

/** True for a document of our own sales (tax invoice / bill of supply), false for an
 *  imported Zoho opening invoice. Same answer as SQL `invoice_is_sale`. */
export function invoiceIsSale(documentKind: string | null | undefined): boolean {
  return (documentKind ?? "tax_invoice") !== OPENING_INVOICE_KIND;
}

/** An invoice imported from Zoho Books (an open balance, not our sale). */
export function isOpeningInvoice(inv: { document_kind?: string | null } | null | undefined): boolean {
  return !!inv && !invoiceIsSale(inv.document_kind);
}

/**
 * Adds the sales-only filter to a PostgREST read of `invoices`. Use it on every query whose
 * rows become GST, revenue, IRN or a Sales voucher. `document_kind` is NOT NULL, so `neq`
 * keeps every tax invoice and bill of supply.
 */
export function onlySaleInvoices<Q>(query: Q): Q {
  return (query as unknown as { neq: (column: string, value: string) => Q }).neq("document_kind", OPENING_INVOICE_KIND);
}
