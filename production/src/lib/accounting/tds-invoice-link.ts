/**
 * R-1670 (1) — which invoice a TDS entry belongs to, when the entry itself does not say.
 *
 * A payment recorded on a QUOTE before its invoice exists (the usual order: money in, then
 * "Generate invoice") writes the tds_receivable row with invoice_id NULL — there is no
 * invoice yet. The TDS Receivable list then showed an empty Invoice column for T-2 on
 * staging. The link is still in the data: tds_receivable.payment_id → payments.quote_id →
 * the invoice raised from that quote. Read-side only, so old rows are covered without a
 * data repair.
 *
 * A quote with more than one live invoice (instalments) is ambiguous — left blank rather
 * than guessed. Void invoices never count.
 */
export interface TdsLinkRow {
  invoice_id: string | null;
  payment_id: string | null;
}

export function fillTdsInvoiceIds<T extends TdsLinkRow>(
  rows: readonly T[],
  payments: readonly { id: string; quote_id: string | null }[],
  invoices: readonly { id: string; quote_id: string | null; status: string | null }[],
): T[] {
  const quoteOfPayment = new Map<string, string>();
  for (const p of payments) if (p.quote_id) quoteOfPayment.set(p.id, p.quote_id);
  const invoicesOfQuote = new Map<string, string[]>();
  for (const inv of invoices) {
    if (!inv.quote_id || inv.status === "void") continue;
    const list = invoicesOfQuote.get(inv.quote_id) ?? [];
    list.push(inv.id);
    invoicesOfQuote.set(inv.quote_id, list);
  }
  return rows.map((r) => {
    if (r.invoice_id || !r.payment_id) return r;
    const quoteId = quoteOfPayment.get(r.payment_id);
    const list = quoteId ? invoicesOfQuote.get(quoteId) : undefined;
    return list && list.length === 1 ? { ...r, invoice_id: list[0] } : r;
  });
}

/** Payment ids whose TDS row still needs its invoice looked up. */
export function paymentIdsMissingInvoice(rows: readonly TdsLinkRow[]): string[] {
  return Array.from(new Set(rows.filter((r) => !r.invoice_id && r.payment_id).map((r) => r.payment_id as string)));
}
