/**
 * R-2422 (Pardeep, 3 Nov — staging Renewals): at renewal time the team must answer "last time
 * kitna diya, kab" without opening other pages. Each Renewals row shows the subscription's LAST
 * PAID: invoice · date · ₹ amount · method, and "History" lists the last 3.
 *
 * A payment belongs to a subscription when it was received against one of that subscription's
 * documents — the same three links R-1433 (lib/invoices/linked-subscriptions) uses:
 *   - its quote: the one that made it (subscriptions.quote_id), its renewal quotes
 *     (subscriptions.renewal_quote_id + every quotes.renewal_subscription_id = it) and its
 *     add-seats quotes (quotes.add_seats_subscription_id = it);
 *   - an invoice raised from one of those quotes (invoices.quote_id, or the quote's invoice_id on
 *     older rows);
 *   - a scheduled instalment's invoice (subscription_billings.invoice_id).
 * Only captured money counts: payments.status 'received' with no refunded_at — a refund
 * (status 'refunded') never becomes "last paid".
 * One quote can make SEVERAL subscriptions (two domains on one quote — subscriptions.quote_id is
 * not unique), so a payment on it is not this subscription's alone: the line says "covers N
 * subscriptions" instead of passing the whole amount off as this one's. Pure — tested in last-paid-r2422.test.ts;
 * the batched read is last-paid-data.ts.
 */
import { rupee, formatDate } from "@/lib/utils";
import { paymentMethodLabel } from "@/lib/payments/method-label";

export const NEVER_PAID = "— never paid in the app";
export const HISTORY_SIZE = 3;

export interface LastPaidInput {
  subs: ReadonlyArray<{ id: string; quote_id: string | null; renewal_quote_id: string | null }>;
  /** Every subscription made from one of those quotes (not only the rows on screen) — to count who shares a payment. */
  quoteSiblings?: ReadonlyArray<{ id: string; quote_id: string | null }>;
  /** quotes linked to a subscription by renewal_subscription_id / add_seats_subscription_id (+ the subs' own quotes, for their invoice_id). */
  linkedQuotes: ReadonlyArray<{ id: string; renewal_subscription_id: string | null; add_seats_subscription_id: string | null; invoice_id: string | null }>;
  billings: ReadonlyArray<{ subscription_id: string; invoice_id: string | null }>;
  invoices: ReadonlyArray<{ id: string; quote_id: string | null }>;
  payments: ReadonlyArray<{
    id: string; amount: number; method: string; status: string; received_at: string;
    refunded_at: string | null; quote_id: string | null; invoice_id: string | null;
  }>;
}

export interface PaidLine {
  paymentId: string;
  /** Rupees, as stored. */
  amount: number;
  method: string;
  receivedAt: string;
  /** The invoice it paid, or the invoice raised from the quote it paid; null = no invoice yet. */
  invoiceId: string | null;
  quoteId: string | null;
  /** How many subscriptions this one payment is for (1 = this one alone). */
  covers: number;
}

export interface LastPaid {
  last: PaidLine;
  /** Newest first, at most HISTORY_SIZE (last included). */
  history: PaidLine[];
}

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  const s = m.get(k);
  if (s) s.add(v); else m.set(k, new Set([v]));
}

/** Every quote and invoice id a set of subscriptions reaches — what last-paid-data reads payments for. */
export function linkedDocs(input: Pick<LastPaidInput, "subs" | "linkedQuotes" | "billings" | "invoices" | "quoteSiblings">) {
  const quoteSubs = new Map<string, Set<string>>();
  const invoiceSubs = new Map<string, Set<string>>();
  for (const s of input.quoteSiblings ?? []) if (s.quote_id) addTo(quoteSubs, s.quote_id, s.id);
  for (const s of input.subs) {
    if (s.quote_id) addTo(quoteSubs, s.quote_id, s.id);
    if (s.renewal_quote_id) addTo(quoteSubs, s.renewal_quote_id, s.id);
  }
  for (const q of input.linkedQuotes) {
    if (q.renewal_subscription_id) addTo(quoteSubs, q.id, q.renewal_subscription_id);
    if (q.add_seats_subscription_id) addTo(quoteSubs, q.id, q.add_seats_subscription_id);
  }
  for (const b of input.billings) if (b.invoice_id) addTo(invoiceSubs, b.invoice_id, b.subscription_id);
  /* An invoice raised from a linked quote — either side of the link. */
  const invoiceOfQuote = new Map<string, string>();
  for (const q of input.linkedQuotes) {
    if (!q.invoice_id) continue;
    for (const sid of quoteSubs.get(q.id) ?? []) addTo(invoiceSubs, q.invoice_id, sid);
    if (!invoiceOfQuote.has(q.id)) invoiceOfQuote.set(q.id, q.invoice_id);
  }
  /* Several invoices on one quote (rare): the first by number names it; cancelled ones are not read (last-paid-data). */
  for (const inv of [...input.invoices].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!inv.quote_id) continue;
    for (const sid of quoteSubs.get(inv.quote_id) ?? []) addTo(invoiceSubs, inv.id, sid);
    if (!invoiceOfQuote.has(inv.quote_id)) invoiceOfQuote.set(inv.quote_id, inv.id);
  }
  return { quoteSubs, invoiceSubs, invoiceOfQuote };
}

const newestFirst = (a: PaidLine, b: PaidLine) =>
  b.receivedAt.localeCompare(a.receivedAt) || b.paymentId.localeCompare(a.paymentId);

/** subscription id → its last captured payment + the last 3; a subscription with none is absent. */
export function lastPaidBySubscription(input: LastPaidInput): Map<string, LastPaid> {
  const { quoteSubs, invoiceSubs, invoiceOfQuote } = linkedDocs(input);
  const bySub = new Map<string, PaidLine[]>();
  const seen = new Set<string>();
  for (const p of input.payments) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.status !== "received" || p.refunded_at) continue;
    const subs = new Set<string>([
      ...(p.quote_id ? quoteSubs.get(p.quote_id) ?? [] : []),
      ...(p.invoice_id ? invoiceSubs.get(p.invoice_id) ?? [] : []),
    ]);
    if (subs.size === 0) continue;
    const line: PaidLine = {
      paymentId: p.id, amount: Number(p.amount) || 0, method: p.method, receivedAt: p.received_at,
      invoiceId: p.invoice_id ?? (p.quote_id ? invoiceOfQuote.get(p.quote_id) ?? null : null),
      quoteId: p.quote_id,
      covers: subs.size,
    };
    for (const sid of subs) {
      const xs = bySub.get(sid);
      if (xs) xs.push(line); else bySub.set(sid, [line]);
    }
  }
  const out = new Map<string, LastPaid>();
  for (const [sid, xs] of bySub) {
    const history = xs.sort(newestFirst).slice(0, HISTORY_SIZE);
    out.set(sid, { last: history[0], history });
  }
  return out;
}

export interface PaidSummary {
  /** The invoice number, else the quote id it was paid against. */
  doc: string | null;
  docKind: "invoice" | "quote" | null;
  date: string;
  /** Whole rupees. */
  amount: string;
  method: string;
  /** "covers 2 subscriptions" when one payment was for several; null = this one alone. */
  shared: string | null;
}

export function lastPaidSummary(p: PaidLine): PaidSummary {
  const doc = p.invoiceId ?? p.quoteId;
  return {
    doc,
    docKind: p.invoiceId ? "invoice" : p.quoteId ? "quote" : null,
    date: formatDate(p.receivedAt),
    amount: rupee(Math.round(p.amount)),
    method: paymentMethodLabel(p.method),
    shared: p.covers > 1 ? `covers ${p.covers} subscriptions` : null,
  };
}
