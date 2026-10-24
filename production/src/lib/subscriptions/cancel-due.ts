/**
 * R-1711 — what "Clear the due" may close when a subscription is cancelled.
 *
 * Billing audit (T-A1): the cancel dialog's "Clear the ₹18,232 still shown as due" set the
 * subscription's balance to 0 while its GST invoice INV-0013 stayed open for ₹18,232 — the
 * subscription said "nothing owed", the invoice, Payment Follow-up and GSTR-1 said ₹18,232.
 *
 * Rule (CGST s.34): an issued tax invoice is reduced only by a CREDIT NOTE on it. So the part
 * of the due an open invoice still asks for is never cleared from the cancel dialog — the
 * dialog offers "Issue credit note for the unused part" on that invoice instead; once the note
 * brings the invoice down, the clear closes what is left. cancel_subscription()
 * (20261024023359_r1711_cancel_keeps_invoice_due.sql) applies the same split on the server.
 */

/** An invoice of this subscription (own quote, renewal quote or instalment). */
export interface SubInvoiceRow {
  id: string;
  status: string | null;
  amount: number | null;
  net_payable: number | null;
  paid_amount: number | null;
  written_off_at?: string | null;
}

/** ₹ the invoice still asks for — 0 unless it is open (pending/overdue, not written off). */
export function openInvoiceDue(i: SubInvoiceRow): number {
  if (i.status !== "pending" && i.status !== "overdue") return 0;
  if (i.written_off_at) return 0;
  return Math.max(0, Math.round((i.net_payable ?? i.amount ?? 0) - (i.paid_amount ?? 0)));
}

export interface CancelDueSplit {
  /** The subscription's balance. */
  owed: number;
  /** Part of it an open invoice still asks for — needs a credit note, never a clear. */
  onInvoices: number;
  /** Part the cancel may clear (nothing on any open invoice). */
  clearable: number;
  /** The open invoices, with what each still asks for. */
  openInvoices: Array<{ id: string; due: number }>;
}

export function cancelDueSplit(outstanding: number | null | undefined, invoices: readonly SubInvoiceRow[]): CancelDueSplit {
  const owed = Math.max(0, Math.round(outstanding ?? 0));
  const openInvoices = invoices
    .map((i) => ({ id: i.id, due: openInvoiceDue(i) }))
    .filter((i) => i.due > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const invDue = openInvoices.reduce((s, i) => s + i.due, 0);
  const onInvoices = Math.min(owed, invDue);
  return { owed, onInvoices, clearable: owed - onInvoices, openInvoices };
}
