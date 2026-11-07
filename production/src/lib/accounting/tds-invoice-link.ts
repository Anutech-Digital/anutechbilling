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

/* ─── R-2558: a sale billed in parts ─────────────────────────────────────────────────────────
 * A part's tax invoice (raise_subscription_billing) keeps invoices.quote_id NULL on purpose (its PDF
 * would print the whole quote) — the link lives on subscription_billings. So a TDS entry booked on a
 * bank receipt for part 1 showed "—" in the Invoice column although INV-… was raised (R-2538 card
 * test, 7 Nov). The receipts of a quote pay its part invoices in order (one pool per quote,
 * instalment_credit): the receipt whose money starts inside part k's invoice belongs to part k.
 * A part not invoiced yet → blank. Read-side only, like R-1670. */

/** One part invoice of a split-billed quote (subscription_billings → invoices). */
export interface TdsPartInvoice {
  quote_id: string;
  invoice_id: string;
  /** subscription_billings.term_start + period_index — the order the parts are billed in. */
  term_start: string | null;
  period_index: number;
  /** The invoice's full amount (net_payable). */
  amount: number;
  status: string | null;
}

/** A received payment on that quote (payments.amount = money + TDS). */
export interface TdsQuotePayment {
  id: string;
  quote_id: string;
  amount: number;
  received_at: string | null;
  created_at: string | null;
}

/** Which part invoice the receipt `paymentId` paid, or null (not invoiced yet / not found). */
export function partInvoiceForPayment(
  paymentId: string,
  quoteId: string,
  parts: readonly TdsPartInvoice[],
  payments: readonly TdsQuotePayment[],
): string | null {
  const byInvoice = new Map<string, TdsPartInvoice>();
  for (const p of parts) {
    if (p.quote_id !== quoteId || p.status === "void") continue;
    const seen = byInvoice.get(p.invoice_id);
    /* R-2092: several parts may share one invoice — keep its earliest part for the order. */
    if (!seen || order(p, seen) < 0) byInvoice.set(p.invoice_id, p);
  }
  const invoices = [...byInvoice.values()].sort(order);
  const paid = payments
    .filter((p) => p.quote_id === quoteId)
    .slice()
    .sort((a, b) => cmp(a.received_at ?? a.created_at, b.received_at ?? b.created_at) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
  const at = paid.findIndex((p) => p.id === paymentId);
  if (at < 0) return null;
  const before = paid.slice(0, at).reduce((s, p) => s + Math.max(0, Number(p.amount) || 0), 0);
  let end = 0;
  for (const inv of invoices) {
    end += Math.max(0, Number(inv.amount) || 0);
    if (before < end) return inv.invoice_id;
  }
  return null;
}

function cmp(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}
function order(a: TdsPartInvoice, b: TdsPartInvoice): number {
  return cmp(a.term_start, b.term_start) || a.period_index - b.period_index;
}

/** R-2558: rows still without an invoice after fillTdsInvoiceIds → their part invoice, when the
 *  payment's quote is billed in parts. */
export function fillTdsPartInvoiceIds<T extends TdsLinkRow>(
  rows: readonly T[],
  quoteOfPayment: ReadonlyMap<string, string>,
  parts: readonly TdsPartInvoice[],
  payments: readonly TdsQuotePayment[],
): T[] {
  return rows.map((r) => {
    if (r.invoice_id || !r.payment_id) return r;
    const quoteId = quoteOfPayment.get(r.payment_id);
    const inv = quoteId ? partInvoiceForPayment(r.payment_id, quoteId, parts, payments) : null;
    return inv ? { ...r, invoice_id: inv } : r;
  });
}
