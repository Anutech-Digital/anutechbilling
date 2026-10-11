/**
 * How much a renewal quote is for, and for how long.
 *
 * ─── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────
 * `createOrGetRenewalQuote` computed the amount as:
 *
 *     const annualAmount = Math.round((input.mrr ?? 0) * 12);
 *
 * Hardcoded twelve, and `term_months` appears nowhere in that file. On 22 Aug 2026 a
 * term-aware reminder LADDER shipped — the cron references `term_months` in four
 * places — but the work stopped at the reminders and never reached the quote. So a
 * MONTHLY subscription gets quoted for a YEAR.
 *
 * Measured 23 Aug 2026 on the row that renews first (c398e832, "Xyz cloud solutions",
 * 10 seats of Business Starter, `term_months = 1`, renewal 27 Aug, `auto_renew = true`):
 *
 *     correct one month   10 x 270          = ₹2,700 ex-GST   → ₹3,186 incl
 *     what it would quote 32,400 x 12       = ₹3,88,800 ex    → ₹4,58,784 incl
 *
 * about **144x** the right figure, four days out, on a subscription set to renew
 * automatically.
 *
 * That factor is two defects compounding, and both are handled here:
 *
 *   1. **The term is assumed.** A 1-month subscription must be quoted for 1 month.
 *   2. **`mrr` on that row holds an ANNUAL figure.** Every other subscription stores a
 *      genuine per-month rate — SAHAKAR is 14 seats at ₹3,780, exactly ₹270/seat/month,
 *      matching the catalogue. That one row stores ₹3,240/seat, which is ₹270 x 12. A
 *      per-seat rate more than about twice the catalogue price cannot be a monthly rate,
 *      and `suspectAnnualMrr` says so rather than quietly multiplying it again.
 *
 * ─── AND IT REFUSES RATHER THAN GUESSES ─────────────────────────────────────
 * When the stored rate looks like an annual figure this does NOT silently divide by 12
 * to "repair" it. Dividing would produce a plausible number from data known to be
 * untrustworthy, and a plausible wrong price on a customer-facing quote is the worst
 * outcome available. The caller is told to stop and have a human look.
 */

/** Whole rupees throughout (CLAUDE.md §13). */
export interface RenewalTermInput {
  /** `subscriptions.mrr`. Expected to be the per-MONTH run rate, ex-GST. */
  mrr: number | null;
  /** `subscriptions.term_months`. 1 = monthly, 12 = annual. */
  termMonths: number | null;
  seats: number | null;
  /**
   * The catalogue's MSRP per seat per month for this plan, when it is known.
   * Null simply skips the sanity check — a bespoke plan has no catalogue row and must
   * not be blocked for it.
   */
  catalogPerSeatMonth?: number | null;
}

export type RenewalTermResult =
  | {
      ok: true;
      /** Months this renewal covers. Never assumed — always from the subscription. */
      termMonths: number;
      /** Ex-GST subtotal for the whole term, in whole rupees. Always perSeatRate × seats (R-837). */
      subtotal: number;
      /** Ex-GST rate per seat for the whole term, whole rupees — the quote line's `rate`. */
      perSeatRate: number;
      /** "annual_yearly" | "monthly" — what the quote line should say it is. */
      commitment: "annual_yearly" | "monthly";
    }
  | {
      ok: false;
      /** Written for the operator and for the cron log: what is wrong, and what to do. */
      reason: string;
    };

/**
 * A stored `mrr` that is really an annual figure.
 *
 * The test is deliberately loose — 2x the catalogue rate, not 12x. A genuine monthly rate
 * can exceed MSRP a little (a support add-on bundled into the line, a rounding), but not
 * double it; and catching a 3x or 6x mistake matters as much as catching exactly 12x.
 * Returns false when there is no catalogue price to compare against, because refusing
 * every bespoke plan would make this unusable.
 */
export function suspectAnnualMrr(input: RenewalTermInput): boolean {
  const seats = input.seats ?? 0;
  const mrr = input.mrr ?? 0;
  const catalog = input.catalogPerSeatMonth ?? 0;
  if (seats <= 0 || mrr <= 0 || catalog <= 0) return false;
  return mrr / seats > catalog * 2;
}

export function renewalTerm(input: RenewalTermInput): RenewalTermResult {
  const seats = input.seats ?? 0;
  const mrr = input.mrr ?? 0;

  if (seats <= 0) {
    return { ok: false, reason: "This subscription has no seat count, so a renewal quote cannot be priced. Set the seats first." };
  }
  if (mrr <= 0) {
    return { ok: false, reason: "This subscription has no monthly rate on it, so a renewal quote cannot be priced. Set the MRR first." };
  }

  /* The term. Missing or nonsensical falls back to 12 — the historical behaviour and
     right for the annual subscriptions that make up almost all of this data — but a
     stored 1 is honoured, which is the whole point of this module. */
  const raw = input.termMonths;
  const termMonths = raw !== null && raw !== undefined && raw >= 1 && raw <= 60 ? Math.round(raw) : 12;

  if (suspectAnnualMrr(input)) {
    const perSeat = Math.round(mrr / seats);
    return {
      ok: false,
      reason:
        `This subscription stores ₹${perSeat.toLocaleString("en-IN")} per seat per month, but the catalogue price is ` +
        `₹${(input.catalogPerSeatMonth ?? 0).toLocaleString("en-IN")}. That looks like a yearly figure in a monthly field, ` +
        `and quoting from it would multiply the price again. Fix the subscription's MRR before generating a renewal quote.`,
    };
  }

  /* R-837 (Pardeep's R-834 rule, same as extensionCharge): the quote line is the price.
     Annual per seat = round(mrr × 12 ÷ seats) (R-803); per seat for the term = annual × years
     on a whole-year term, else round(annual × months ÷ 12); subtotal = per seat × seats, so
     rate × qty on the quote IS the subtotal. Before, subtotal = round(mrr × months) and the
     line carried round(subtotal ÷ seats) "for display": 10 seats at ₹83/mo read
     ₹100 × 10 = ₹1,000 over a ₹996 subtotal. */
  const annualPerSeat = Math.round((mrr * 12) / seats);
  const perSeatRate = termMonths % 12 === 0
    ? annualPerSeat * (termMonths / 12)
    : Math.round((annualPerSeat * termMonths) / 12);
  const subtotal = perSeatRate * seats;
  return {
    ok: true,
    termMonths,
    subtotal,
    perSeatRate,
    /* A 1-month renewal is not an annual commitment, and labelling it one is what makes
       record_payment build the wrong subscription on the way back in. */
    commitment: termMonths === 1 ? "monthly" : "annual_yearly",
  };
}
