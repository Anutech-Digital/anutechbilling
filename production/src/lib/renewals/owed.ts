/**
 * R-2818 (renewals 12-question audit, 14 Nov 2026) — what ONE subscription still owes, by the
 * customer page's own rule, so Renewals and the customer page can never give two answers.
 *
 * Seen on localhost (E2E Test Co): SCN Kochi's row said "Previous term ₹25,488 still unpaid" — read
 * from subscriptions.outstanding_amount alone, a balance no quote or invoice asks for (and the same
 * figure as its next-term DRAFT quote) — while its customer page said "Outstanding: All clear". The
 * follow-up dialog said "Still owes ₹3,250" (the renewal's price) for Greentin Check, which has no
 * invoice at all.
 *
 * The customer page's Outstanding is its Statement's closing (R-2183, customer-statement.ts):
 * issued invoices (never draft / void) less payments and credit notes, plus debit notes, plus a
 * subscription instalment owed before any invoice exists — counted ONLY when the subscription has a
 * quote and that quote has no invoice (subscriptionReceivable, R-1708; the invoice is the claim once
 * raised). This file is that rule for one subscription's linked documents:
 *
 *   owed = Σ issued linked invoices   invoiceAmountDue (net payable − money in; 0 when paid, void,
 *                                     written off) − credit notes + debit notes, never below 0
 *        + the balance not invoiced   uninvoicedSubscriptionDue — the customer page calls the same
 *                                     function for its Statement
 *
 * A quote — draft, sent or accepted — is never "owed" by itself. Amounts are rupees as stored,
 * summed in paise. Pure — tested in owed-r2818.test.ts.
 */
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { subscriptionReceivable, type SubscriptionDueFields } from "@/lib/payments/receivables";

/** An invoice linked to the subscription — only what bears on what is still owed. */
export interface OwedInvoice {
  id: string;
  status: string | null;
  amount?: number | null;
  net_payable?: number | null;
  paid_amount?: number | null;
  written_off_at?: string | null;
  /** Credit / debit notes against it (₹, positive); null / undefined = none known. */
  credit?: number | null;
  debit?: number | null;
  /** The quote it was raised from. */
  sourceQuoteId?: string | null;
}

/** Never issued, or cancelled: not owed (the Statement leaves both off). */
const NOT_ISSUED = new Set(["draft", "void", "cancelled"]);

const paise = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0);

/** What one issued invoice still asks for, after its credit / debit notes. 0 = nothing. */
export function invoiceOwed(inv: OwedInvoice): number {
  if (NOT_ISSUED.has((inv.status ?? "").toLowerCase())) return 0;
  const base = invoiceAmountDue(inv);
  if (!(base > 0)) return 0;
  return Math.max(0, paise(base) - paise(inv.credit) + paise(inv.debit)) / 100;
}

/**
 * The subscription's balance that NO invoice asks for yet — the customer Statement's
 * "Instalment due · <quote> (not invoiced yet)" line: only with a quote, and only while that quote
 * has no invoice. A balance with no quote at all is on no document, so it is not owed here
 * (SCN Kochi — the customer page says All clear).
 */
export function uninvoicedSubscriptionDue(sub: SubscriptionDueFields, invoicedQuoteIds: ReadonlySet<string>): number {
  if (!sub.quote_id) return 0;
  return subscriptionReceivable(sub, invoicedQuoteIds);
}

export interface SubscriptionOwed {
  /** ₹ still owed on this subscription's documents. */
  total: number;
  /** Each issued linked invoice with money due, in the order given. */
  invoices: { id: string; due: number; sourceQuoteId: string | null }[];
  /** The subscription's own quote, owed but not invoiced yet; null = none. */
  notInvoiced: { quoteId: string; due: number } | null;
}

/**
 * Everything one subscription still owes. `invoices` = every invoice linked to it (any status —
 * draft / void ones count nothing); `invoicedQuoteIds` = the quotes any of them came from (void ones
 * too, as on the customer page).
 */
export function subscriptionOwed(
  sub: SubscriptionDueFields,
  invoices: readonly OwedInvoice[],
  invoicedQuoteIds: ReadonlySet<string> = new Set(invoices.map((i) => i.sourceQuoteId).filter((q): q is string => !!q)),
): SubscriptionOwed {
  const seen = new Set<string>();
  const owedInvoices: SubscriptionOwed["invoices"] = [];
  for (const i of invoices) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    const due = invoiceOwed(i);
    if (due > 0) owedInvoices.push({ id: i.id, due, sourceQuoteId: i.sourceQuoteId ?? null });
  }
  const notDue = uninvoicedSubscriptionDue(sub, invoicedQuoteIds);
  const notInvoiced = notDue > 0 && sub.quote_id ? { quoteId: sub.quote_id, due: notDue } : null;
  const total = (owedInvoices.reduce((s, i) => s + paise(i.due), 0) + paise(notInvoiced?.due)) / 100;
  return { total, invoices: owedInvoices, notInvoiced };
}

/**
 * R-2818: the part of it that is from BEFORE this renewal — the renewal's own invoice (raised from
 * the open renewal quote or the renewal's billed part) is this renewal's money, not "previous term".
 * Under ₹1 is paise rounding (R-2752), never "still unpaid".
 */
export function priorTermOwed(owed: SubscriptionOwed, renewalQuoteIds: ReadonlySet<string>): SubscriptionOwed {
  const invoices = owed.invoices.filter((i) => !(i.sourceQuoteId && renewalQuoteIds.has(i.sourceQuoteId)));
  const notInvoiced = owed.notInvoiced && !renewalQuoteIds.has(owed.notInvoiced.quoteId) ? owed.notInvoiced : null;
  const total = (invoices.reduce((s, i) => s + paise(i.due), 0) + paise(notInvoiced?.due)) / 100;
  return total >= 1 ? { total, invoices, notInvoiced } : { total: 0, invoices: [], notInvoiced: null };
}
