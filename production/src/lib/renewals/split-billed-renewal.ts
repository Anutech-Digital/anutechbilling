/**
 * R-808 (10 Oct 2026) — how a subscription billed in parts (monthly / quarterly / half-yearly)
 * renews: it does NOT get a whole-term renewal quote. Its term rolls on by itself and the
 * billing cron invoices the new term's instalments, one each, on their dates.
 *
 * ─── WHY (proven on the local DB, rolled back) ─────────────────────────────────────────
 * Quarterly, 8 seats, mrr ₹2,160, all four Year-1 quarters invoiced and paid (₹30,584).
 * The renewals cron made the renewal quote createOrGetRenewalQuote writes — the WHOLE year,
 * ₹30,586 — and the customer paid it: record_payment rolled renewal_date a year and
 * generate_invoice issued one whole-year PAID invoice (the renewal quote carries no
 * billing_cycle, so the split-billed invoice guard does not stop it). The billing cron then
 * laid the new year's four quarters and raise_subscription_billing issued them PENDING,
 * ₹7,646 each — it credits only payments on the subscription's ORIGINAL quote — so ₹30,584
 * was demanded a second time for a year already paid and invoiced. Same gap R-807 proved
 * for "Extend term".
 *
 * Crediting the renewal payment against the instalments was the other option. It needs a
 * migration and still leaves a whole-year GST invoice AND four instalment invoices for the
 * same supply. Not issuing the whole-year quote at all removes both: the instalments are
 * how this customer pays, every term, exactly as in the first year.
 */
import type { BillingCycle } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { followingTermStart, isAnniversaryRenewal } from "@/lib/billing/subscription-schedule";
import { addMonthsClamped, addDaysISO } from "@/lib/billing/schedule";

function cycleWord(cycle: BillingCycle | null | undefined): string {
  return cycle === "half_yearly" ? "half-yearly" : String(cycle);
}

/**
 * Why no renewal quote may be issued for this subscription — or null when one may.
 * Read by the renewals cron, "Generate renewal quote" and "Send now".
 */
export function renewalQuoteBlockedReason(cycle: BillingCycle | null | undefined): string | null {
  if (!isSplitBilled(cycle)) return null;
  return `This subscription is billed ${cycleWord(cycle)}, so each part gets its own invoice on its date. A renewal quote would bill the next term twice. It renews on its own: the term rolls on and the next parts are invoiced on their dates.`;
}

export interface SplitRenewalFields {
  billing_cycle: BillingCycle | null;
  term_months:   number;
  start_date:    string | null;
  renewal_date:  string | null;
}

/**
 * The renewal_date one term on, in the SAME stored shape (see followingTermStart):
 *   - anniversary row (renewal = start + N terms) → start + (N+1) terms, counted from the
 *     start so a 31st does not drift to the 28th and stay there;
 *   - inclusive last day → (first day of the next term + one term) − 1 day.
 * Null without a renewal date.
 */
export function nextTermRenewalDate(sub: Omit<SplitRenewalFields, "billing_cycle">): string | null {
  if (!sub.renewal_date) return null;
  const term = Math.max(1, sub.term_months ?? 12);
  if (isAnniversaryRenewal(sub) && sub.start_date) {
    const start = sub.start_date.slice(0, 10);
    const renewal = sub.renewal_date.slice(0, 10);
    for (let n = 1; n <= 100; n++) {
      if (addMonthsClamped(start, n * term) === renewal) return addMonthsClamped(start, (n + 1) * term);
    }
  }
  return addDaysISO(addMonthsClamped(followingTermStart(sub), term), -1);
}

export type SplitRenewalStep =
  | { kind: "not_split_billed" }
  /** The current term is still running — nothing to do, and no reminder to send. */
  | { kind: "wait"; nextTermStart: string }
  /** The next term has begun: move renewal_date to `newRenewalDate`. */
  | { kind: "roll"; nextTermStart: string; newRenewalDate: string }
  /** The next term has begun but an open renewal quote is linked: paying it would roll the
   *  term a second time and bill it twice, so a person decides. */
  | { kind: "held_open_quote"; nextTermStart: string; quoteId: string };

/** What the renewals cron does today with an auto-renewing subscription. */
export function splitBilledRenewalStep(
  sub: SplitRenewalFields & { renewal_quote_id: string | null },
  todayISO: string,
): SplitRenewalStep {
  if (!isSplitBilled(sub.billing_cycle) || !sub.renewal_date) return { kind: "not_split_billed" };
  const nextTermStart = followingTermStart(sub);
  if (todayISO < nextTermStart) return { kind: "wait", nextTermStart };
  if (sub.renewal_quote_id) return { kind: "held_open_quote", nextTermStart, quoteId: sub.renewal_quote_id };
  const newRenewalDate = nextTermRenewalDate(sub);
  if (!newRenewalDate) return { kind: "not_split_billed" };
  return { kind: "roll", nextTermStart, newRenewalDate };
}
