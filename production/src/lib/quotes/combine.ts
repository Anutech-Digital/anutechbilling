/**
 * R-1527 — "Combine quotes into one" (Pardeep, 17 Oct 2026 — R-1524 option A).
 *
 * A customer wants ONE tax invoice for several accepted quotes. An issued GST invoice is
 * never merged (R-1524), so the quotes are merged first into one NEW quote, and the normal
 * "Generate invoice" runs on that quote. The database function `combine_quotes` decides
 * everything and refuses with its own words; this module only pre-sorts the customer's
 * quotes on screen so nobody ticks a quote that is certain to be refused.
 *
 * The screen checks only what it can see on the quote row. The server additionally checks
 * every money table (payments, advance credit, coupons, subscriptions, provisioning,
 * referral), that each saved total matches its lines, and the domain rules that keep
 * subscription/PO activation on payment the same — see
 * supabase/migrations/20261017161500_r1527_combine_quotes.sql.
 */

/** The quote fields the pre-check reads. Deliberately not the whole row. */
export interface CombinableQuote {
  id: string;
  status: string | null;
  invoice_id: string | null;
  superseded_by: string | null;
  payment_status: string | null;
  approval_status: string | null;
  is_renewal: boolean | null;
  is_extension: boolean | null;
  is_add_seats: boolean | null;
  credit_activated_at: string | null;
  discount_pct: number | null;
  currency: string | null;
  exchange_rate: number | null;
  tax_rate: number | null;
  billing_cycle: string | null;
  is_one_off: boolean | null;
  payment_terms_days: number | null;
  amount: number | null;
}

/**
 * Should this quote appear in the combine list at all? Invoiced quotes and quotes already
 * replaced never do — an issued invoice is never combined, and a replaced quote is closed.
 */
export function showInCombineList(q: Pick<CombinableQuote, "status" | "invoice_id" | "superseded_by">): boolean {
  return q.status === "accepted" && !q.invoice_id && !q.superseded_by;
}

/** Why this one quote cannot be combined (§24: says what to do), or null when it can. */
export function combineBlockReason(q: CombinableQuote): string | null {
  if (q.invoice_id) return `Already has invoice ${q.invoice_id} — an issued invoice is never combined.`;
  if (q.superseded_by) return `Replaced by ${q.superseded_by} — use that quote.`;
  if (q.status !== "accepted") return "Not accepted yet — mark it accepted first.";
  if (!["none", "awaiting", null].includes(q.payment_status)) {
    return "Money is already recorded on it — invoice it on its own.";
  }
  if (q.approval_status === "pending") return "Waiting for approval — get it approved first.";
  if (q.approval_status === "rejected") return "Approval was refused — fix and re-approve it first.";
  if (q.is_renewal || q.is_extension || q.is_add_seats) {
    return "Renewal / extension / add-seats quote — it updates a subscription, so invoice it on its own.";
  }
  if (q.credit_activated_at) return "Activated on credit — its subscriptions already exist; invoice it on its own.";
  if ((q.discount_pct ?? 0) !== 0) return "Has a quote-level discount — open it, Edit and Save once, then combine.";
  return null;
}

/** The facts every combined quote must share. */
function shareKey(q: CombinableQuote): string {
  return [
    (q.currency ?? "INR").toUpperCase(),
    q.exchange_rate ?? 1,
    q.tax_rate ?? 18,
    q.billing_cycle ?? "yearly",
    q.is_one_off ? "one-off" : "recurring",
    q.payment_terms_days ?? "default",
  ].join("|");
}

/**
 * Why this quote cannot join the ones already ticked (different currency, GST, billing,
 * one-off vs recurring, payment terms), or null. `anchor` is the first ticked quote.
 */
export function combineMismatch(anchor: CombinableQuote | undefined, q: CombinableQuote): string | null {
  if (!anchor || anchor.id === q.id) return null;
  if ((anchor.currency ?? "INR").toUpperCase() !== (q.currency ?? "INR").toUpperCase()
      || (anchor.exchange_rate ?? 1) !== (q.exchange_rate ?? 1)) {
    return `Different currency from ${anchor.id}.`;
  }
  if ((anchor.tax_rate ?? 18) !== (q.tax_rate ?? 18)) return `Different GST (${q.tax_rate ?? 18}%) from ${anchor.id}.`;
  if ((anchor.billing_cycle ?? "yearly") !== (q.billing_cycle ?? "yearly")) return `Billed ${q.billing_cycle ?? "yearly"}, ${anchor.id} is not.`;
  if (!!anchor.is_one_off !== !!q.is_one_off) return `One-time vs recurring — not like ${anchor.id}.`;
  if (shareKey(anchor) !== shareKey(q)) return `Different payment terms from ${anchor.id}.`;
  return null;
}

/** Sum of the ticked quotes' totals — what the combined quote should come to (± GST rounding). */
export function combinedTotal(quotes: ReadonlyArray<Pick<CombinableQuote, "amount">>): number {
  return quotes.reduce((s, q) => s + (q.amount ?? 0), 0);
}
