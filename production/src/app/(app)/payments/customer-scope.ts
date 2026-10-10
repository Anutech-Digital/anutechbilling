/* R-533: /payments?customer=<id> — scope EVERYTHING on the page to that customer.

   The filter used to narrow only the payment list. Tab counts, the "N of M payments ·
   ₹X collected" line, the analytics strip (Collected MTD, Partial Quotes, Awaiting GST
   Invoice, Top method), the subscription dues card and the All / Subscription / Project
   counts stayed company-wide — so with Delhom picked the page showed one ₹38,232 card
   beside "Received 2 · ₹76,464 collected", and the owner read it as Delhom paying twice.

   Pure: the page passes its loaded lists in, gets the customer's slice back, and computes
   every number from that slice. No customer → the lists come back untouched. */

export interface ScopablePayment {
  customer_id?: string | null;
  quote_id: string;
}

/** A payment belongs to the customer by its own customer_id, or — when that is empty
 *  (a receipt taken before the lead was converted) — by the customer on its quote. */
export function paymentBelongsTo(
  p: ScopablePayment,
  customerId: string,
  quoteCustomerId: (quoteId: string) => string | null | undefined,
): boolean {
  return p.customer_id === customerId || quoteCustomerId(p.quote_id) === customerId;
}

export function scopeToCustomer<
  P extends ScopablePayment,
  J extends { customer_id: string | null },
  Q extends { id: string; customer_id: string | null },
  O extends { customer_id: string | null },
>(
  lists: { payments: readonly P[]; projectPayments: readonly J[]; quotes: readonly Q[]; outstanding: readonly O[] },
  customerId: string | null | undefined,
): { payments: P[]; projectPayments: J[]; quotes: Q[]; outstanding: O[] } {
  if (!customerId) {
    return {
      payments: [...lists.payments],
      projectPayments: [...lists.projectPayments],
      quotes: [...lists.quotes],
      outstanding: [...lists.outstanding],
    };
  }
  const quoteCustomer = new Map<string, string | null>();
  for (const q of lists.quotes) quoteCustomer.set(q.id, q.customer_id);
  return {
    payments: lists.payments.filter((p) => paymentBelongsTo(p, customerId, (id) => quoteCustomer.get(id))),
    projectPayments: lists.projectPayments.filter((p) => p.customer_id === customerId),
    quotes: lists.quotes.filter((q) => q.customer_id === customerId),
    outstanding: lists.outstanding.filter((o) => o.customer_id === customerId),
  };
}

/** Tab counts + the all-time collected total, from an already-scoped list. */
export function paymentTotals(
  payments: readonly { status: string; amount: number }[],
  projectPayments: readonly { amount: number }[],
): { counts: Record<string, number>; received: number; projectCollected: number; totalCollected: number } {
  const counts: Record<string, number> = { all: payments.length };
  let received = 0;
  for (const p of payments) {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
    if (p.status === "received") received += p.amount;
  }
  const projectCollected = projectPayments.reduce((s, p) => s + p.amount, 0);
  return { counts, received, projectCollected, totalCollected: received + projectCollected };
}

/** The line above the list.
 *  Company-wide: "3 of 47 payments · ₹X collected all-time" (unchanged).
 *  One customer: "1 payment · ₹38,232 collected from Delhom" — or "1 of 2 payments · …"
 *  when a tab or search narrows that customer's list further. */
export function paymentsSummaryLine(opts: {
  shown: number;
  total: number;
  collected: string;
  customerName?: string | null;
}): string {
  const { shown, total, collected, customerName } = opts;
  const noun = (n: number) => `payment${n === 1 ? "" : "s"}`;
  if (customerName == null) return `${shown} of ${total} payments · ${collected} collected all-time`;
  const count = shown === total ? `${total} ${noun(total)}` : `${shown} of ${total} ${noun(total)}`;
  return `${count} · ${collected} collected from ${customerName}`;
}
