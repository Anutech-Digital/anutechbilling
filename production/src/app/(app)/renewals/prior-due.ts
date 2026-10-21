/**
 * R-1703 (21 Oct 2026): "Previous term ₹X still unpaid" (card asked "Pichhla ₹X abhi baaki hai";
 * app UI copy is English since R-246 — ui-copy-english.test.ts).
 *
 * Billing audit (local, T-A2): the subscription owed ₹9,629 for its current term, a renewal
 * quote was generated and paid, and nothing on the Renewals row or the renewal quote said the
 * old term was still open. record_payment now keeps that balance on the subscription after the
 * roll-forward (migration 20261021023154); this is the warning shown BEFORE that happens.
 *
 * A renewal quote cannot be accepted on credit (activate_quote_on_credit refuses it), so while
 * a renewal quote is open — and after it is paid — the subscription's outstanding_amount is
 * what the earlier term(s) still owe. Written-off balances are not "baaki" (same rule as the
 * dashboard and the risk score: lib/accounting/receivables-due subscriptionDue).
 */
import { rupee } from "@/lib/utils";
import { subscriptionDue } from "@/lib/accounting/receivables-due";

export interface PriorDueSub {
  id: string;
  outstanding_amount: number | null;
  written_off_at?: string | null;
  renewal_quote_id?: string | null;
}

/** The unpaid amount of the previous term, 0 when nothing is owed. */
export function priorTermDue(sub: Pick<PriorDueSub, "outstanding_amount" | "written_off_at">): number {
  return subscriptionDue({
    customer_id: null,
    outstanding_amount: sub.outstanding_amount,
    written_off_at: sub.written_off_at ?? null,
  });
}

/** The warning text, or null when the previous term is paid. */
export function priorTermDueText(sub: Pick<PriorDueSub, "outstanding_amount" | "written_off_at">): string | null {
  const due = priorTermDue(sub);
  return due > 0 ? `Previous term ${rupee(due)} still unpaid` : null;
}

/**
 * The subscription a renewal quote renews: quotes.renewal_subscription_id (R-1574, kept after
 * payment), else the subscription still pointing at the quote. Keyed by the quote's own link,
 * never "latest for the customer" (a customer can have two subscriptions).
 */
export function renewalSubOfQuote<S extends PriorDueSub>(
  quote: { id: string; is_renewal?: boolean | null; is_extension?: boolean | null; renewal_subscription_id?: string | null },
  subs: readonly S[],
): S | undefined {
  if (!quote.is_renewal && !quote.is_extension && !quote.renewal_subscription_id) return undefined;
  if (quote.renewal_subscription_id) {
    const byId = subs.find((s) => s.id === quote.renewal_subscription_id);
    if (byId) return byId;
  }
  return subs.find((s) => s.renewal_quote_id === quote.id);
}
