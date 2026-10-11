/**
 * How a subscription's term and renewal distance are presented.
 *
 * These two live in `lib` rather than inside the page because `term().months`
 * multiplies MRR into a rupee figure the operator reads off the screen
 * ("Annual · ₹16,200"). Misclassifying a quarterly subscription as annual would
 * show four times the real renewal amount — that is money display, so it gets a
 * test rather than a hope.
 */
import { daysBetween } from "@/lib/utils";

export interface Term {
  label: string;
  /** Canonical months for the bucket — matches the label, so the total the
   *  operator reads always agrees with the term they are told it is. */
  months: number;
}

/**
 * Billing term, derived from the start↔renewal span.
 *
 * `months` comes back alongside the label because MRR alone misleads. Every
 * subscription in this tenant is annual, so a card reading "₹1,350 /mo" hides
 * the ₹16,200 that will actually be invoiced at renewal — which is the number
 * needed when picking up the phone.
 */
export function term(start: string | null | undefined, renewal: string | null | undefined): Term | null {
  if (!start || !renewal) return null;
  const span = daysBetween(start, renewal);
  // A renewal date before the start date is corrupt data, not a term.
  if (!Number.isFinite(span) || span <= 0) return null;
  const m = Math.round(span / 30.44);
  if (m <= 1) return { label: "Monthly",     months: 1  };
  if (m <= 4) return { label: "Quarterly",   months: 3  };
  if (m <= 8) return { label: "Half-yearly", months: 6  };
  return       { label: "Annual",      months: 12 };
}

/**
 * How far away the renewal is, in words.
 *
 * WHY THIS EXISTS. The subscription card showed only a date ("23 Jul 2027")
 * plus a "Xd" badge gated at 30 days. Every one of this tenant's 54
 * subscriptions renews 181–365 days out, so that badge never rendered once —
 * the page's own "Expiring 30d" tab reads 0 — and the operator was left doing
 * date arithmetic in their head on a phone.
 *
 * Exact days while it is close enough to act on; months beyond that, because
 * "in 344 days" is a number nobody can feel.
 */
export function renewalDistance(days: number): string {
  if (!Number.isFinite(days)) return "—";
  if (days < 0)   return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "in 1 day";
  if (days <= 60) return `in ${days} days`;
  return `in ~${Math.round(days / 30.44)} months`;
}

/* ── What is actually invoiced at renewal ───────────────────────────────────── */

export interface TermValue {
  /** ₹, whole rupees. */
  amount: number;
  /**
   * True when this is the CONTRACTED figure. False when it was rebuilt from a rounded
   * monthly and may be a few rupees out.
   */
  exact: boolean;
}

/**
 * The amount a term is worth — and whether we actually know it.
 *
 * ─── THE ₹4 THAT NOBODY AGREED TO ───────────────────────────────────────────
 * Reported live: a support plan quoted at ₹2,000 a year showed as "Annual · ₹2,004".
 * Nothing was corrupt. `subscriptions` stores only a MONTHLY figure, so ₹2,000/yr became
 * mrr = round(2000 / 12) = 167, and the page rebuilt the annual as 167 × 12 = 2,004. The
 * ₹4 was invented by the round trip.
 *
 * It is invisible on most rows, which is what makes it nasty: ₹45,360 a year divides
 * evenly by 12, so the Google line on the same screen was exactly right while the support
 * line beside it was wrong. Any annual price not divisible by 12 is out by up to ₹11 —
 * enough for a customer to query a renewal invoice against the quote they signed.
 *
 * ─── SO THE CONTRACTED AMOUNT IS PREFERRED, AND THE REST IS LABELLED ────────
 * A subscription raised from a quote carries `quote_id`, and that quote's line still holds
 * the negotiated annual `rate`. When the caller can supply it, that is the number — exact,
 * to the rupee. When it cannot (a subscription entered by hand, or an older row), the
 * monthly × months answer is still shown, but flagged `exact: false` so the screen can say
 * "about" instead of asserting a precision it does not have.
 *
 * Storing the annual figure would fix this properly and needs a migration; until then, not
 * lying about it is the part that can be done today.
 */
export function termValue(
  mrr: number | null | undefined,
  months: number,
  /** ₹/year from the originating quote line (`rate × qty`), when known. */
  contractedAnnual?: number | null,
): TermValue {
  if (contractedAnnual != null && contractedAnnual > 0) {
    /* Scaled from the annual for a non-annual term, and rounded ONCE — going via a
       monthly would reintroduce exactly the drift this function exists to remove. */
    return { amount: Math.round((contractedAnnual * months) / 12), exact: true };
  }
  return { amount: Math.round((mrr ?? 0) * months), exact: false };
}

/** "₹2,000" when known, "about ₹2,004" when rebuilt from a rounded monthly. */
export function termValueLabel(v: TermValue, rupees: (n: number) => string): string {
  return v.exact ? rupees(v.amount) : `about ${rupees(v.amount)}`;
}

/**
 * R-876. The term shown on a subscriptions list row — the BILLING CYCLE wins when it
 * says something the start↔renewal span cannot.
 *
 * A quarterly-billed annual commitment (R-826) spans twelve months, so `term()` alone
 * called it "Annual · about ₹18,000" — a row that never mentioned it is invoiced every
 * three months. `subscriptions.billing_cycle` knows, so:
 *   quarterly   → "Quarterly",   amount = one quarter's invoice
 *   half_yearly → "Half-yearly", amount = one half-year's invoice
 *   monthly     → "Monthly"      (no amount — the MRR is already on the row)
 *   yearly      → the span, as before. 'yearly' is the column DEFAULT, so older rows
 *                 written before billing_cycle existed carry it whatever their real term
 *                 was; the span stays the better witness for them.
 * `months` is what one invoice covers, so termValue(mrr, months, annual) is the amount
 * of one invoice — never the year shown next to the word "Quarterly".
 */
export function rowTerm(
  billingCycle: string | null | undefined,
  start: string | null | undefined,
  renewal: string | null | undefined,
): Term | null {
  if (billingCycle === "quarterly")   return { label: "Quarterly",   months: 3 };
  if (billingCycle === "half_yearly") return { label: "Half-yearly", months: 6 };
  if (billingCycle === "monthly")     return { label: "Monthly",     months: 1 };
  return term(start, renewal);
}
