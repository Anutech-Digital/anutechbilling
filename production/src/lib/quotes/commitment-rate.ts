/**
 * Converting a quote line's rate when its commitment changes.
 *
 * ─── THE UNIT CHANGES WITH THE COMMITMENT ───────────────────────────────────
 * `LineCommitment` has two families and they do not measure the same thing
 * (database.types.ts:1052):
 *
 *   monthly     — the flex tier, no commitment. The rate is **per seat per MONTH**.
 *   annual_*    — the annual price tier. The rate is **per seat per YEAR**.
 *
 * Three SQL regression tests pin that convention down. `monthly_subscription` asserts
 * "the line is Rs 38,232 PER MONTH"; `record_payment_billing_cycle_decouple` asserts
 * "expected 32400 (the whole month)"; `renewal_and_subscription_creation` asserts
 * "mrr should be 3900 (the full month)". `record_payment` relies on it —
 * `v_line_amount / case when v_is_monthly then 1.0 else 12.0 end` is CORRECT because a
 * monthly line's amount is already one month.
 *
 * ─── THE BUG THIS FIXES ─────────────────────────────────────────────────────
 * `quote-builder.tsx`'s `updateCommitment` recomputed the rate from the catalogue's
 * price tier — and when the item had no tier, fell through to:
 *
 *     // No catalog link OR tier not found — just update commitment, keep current rate
 *     return { ...l, commitment };
 *
 * Keeping the rate is right within a family and wrong across one. Switch an annual line
 * to monthly and a **per-YEAR** rate stays on a **per-MONTH** line: a twelvefold
 * overcharge, on a quote, with nothing on screen to show it.
 *
 * Not hypothetical. Live quote Q-TEST-2026-27-0009 carries `commitment: "monthly"` with
 * `rate: 3240` and `cost: 1320` — 270x12 and 110x12 against a catalogue of ₹270/₹110 —
 * and its item's `prices` column is `{}`, so it took exactly this fallback. ₹38,232 was
 * recorded against it for one month of ten seats that should cost ₹3,186.
 *
 * ─── WHY THIS IS ARITHMETIC AND NOT PRICING ─────────────────────────────────
 * Dividing by twelve converts a unit; it does not decide a price. A real monthly-flex
 * tier usually costs MORE per month than a twelfth of the annual rate, which is exactly
 * why the catalogue path above is preferred and left untouched. This only rescues the
 * case where there is no tier to read — and getting the unit right is strictly better
 * than leaving it twelve times wrong.
 */
import type { LineCommitment } from "@/lib/supabase/database.types";

/** Is this commitment priced per YEAR? Everything except flex-monthly. */
export function isAnnualTier(c: LineCommitment | null | undefined): boolean {
  return (c ?? "annual_yearly") !== "monthly";
}

export interface RateConversion {
  rate: number;
  cost: number;
  /** True when the unit actually changed, for the caller's own messaging. */
  converted: boolean;
}

/**
 * Restate `rate` and `cost` in the unit the new commitment implies.
 *
 * Same family in and out → returned untouched, because nothing about the unit moved.
 * A missing or zero cost stays zero: `cost = 0` is deliberate elsewhere in the builder
 * (it makes a quote's margin visibly wrong rather than plausibly wrong) and dividing
 * zero into a fake number would undo that.
 */
export function convertRateForCommitment(args: {
  rate: number | null | undefined;
  cost: number | null | undefined;
  from: LineCommitment | null | undefined;
  to: LineCommitment;
  /** R-2637: a foreign-currency (USD) line — its ₹ rate keeps paise, never rounded to whole rupees. */
  keepPaise?: boolean;
}): RateConversion {
  /* R-2637: a rate with paise (a USD price in ₹: $2 @ 95.10 = ₹190.20) keeps them — rounding it to
     whole rupees here put the per-unit drift back. Whole-rupee (INR) rates round exactly as before. */
  const raw = Math.max(0, args.rate ?? 0);
  const paise = args.keepPaise === true || !Number.isInteger(raw);
  const rate = paise ? Math.round(raw * 1e6) / 1e6 : raw;
  const cost = Math.max(0, Math.round(args.cost ?? 0));

  const wasAnnual = isAnnualTier(args.from);
  const isAnnual = isAnnualTier(args.to);
  if (wasAnnual === isAnnual) return { rate, cost, converted: false };

  /* Rounded, not floored: a ₹3,245/year rate becomes ₹270 a month rather than ₹270.41,
     and the quote total is recomputed from qty x rate anyway. */
  const factor = isAnnual ? 12 : 1 / 12;
  return {
    rate: Math.max(0, paise ? Math.round(rate * factor * 1e6) / 1e6 : Math.round(rate * factor)),
    cost: Math.max(0, Math.round(cost * factor)),
    converted: true,
  };
}
