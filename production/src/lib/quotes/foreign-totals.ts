/**
 * R-1677 — the ONE way a foreign-currency (export) quote or invoice is totalled for display.
 *
 * Books stay in whole rupees (the stored line `rate` is ₹). The customer sees their own
 * currency, and every screen must show the SAME number: staging 19 Oct (Q-5F40-27-0100) had
 * the builder at $338 (whole-dollar "Round off total" on by default), the accept page at
 * $338.40, the staff preview in ₹ and the invoice ₹ only.
 *
 * The rule (it was already the accept page's and the quote PDF's):
 *   unit   = ₹ rate ÷ exchange rate, rounded to the cent
 *   amount = qty × unit, rounded to the cent, less the line's own discount_pct
 *   subtotal = Σ amounts; then quote discount %, tax %, total — each rounded to the cent.
 * So qty × unit always equals the amount and the lines add up to the total the customer is
 * asked to pay. Never rounded to whole dollars. A plain ₹ total ÷ rate ($32,400 ÷ 95.7485 =
 * $338.39) is NOT the total — it disagrees with the lines the customer sees ($33.84 × 10).
 * The ₹ ↔ $ difference that leaves (₹32,400 vs $338.40 × rate) is forex, booked by R-1678.
 */

export interface ForeignLineIn {
  qty: number;
  /** ₹ per unit, as stored on the line. */
  rate: number;
  discount_pct?: number | null;
}

export interface ForeignFigures {
  lines: Array<{ unit: number; gross: number; amount: number }>;
  subtotal: number;
  discount: number;
  taxable: number;
  tax: number;
  total: number;
}

/** Round to the cent, without 1.005 → 1.00 float drift. */
export function cents(v: number): number {
  return Math.round((v + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
}

/** ₹ per unit → the customer's currency per unit (to the cent). */
export function foreignUnit(inr: number, fx: number): number {
  return fx > 0 ? cents(inr / fx) : 0;
}

export function foreignQuoteFigures(args: {
  lines: readonly ForeignLineIn[];
  /** ₹ per one unit of the foreign currency. */
  fx: number;
  /** Quote-level discount %, applied to the subtotal (usually 0 — discounts live in the rate). */
  discountPct?: number | null;
  /** 0 for an export (zero-rated) supply. */
  taxRate?: number | null;
}): ForeignFigures {
  const fx = args.fx > 0 ? args.fx : 1;
  const lines = args.lines.map((l) => {
    const unit  = foreignUnit(l.rate, fx);
    const gross = cents(l.qty * unit);
    const amount = cents(gross - cents(gross * ((l.discount_pct ?? 0) / 100)));
    return { unit, gross, amount };
  });
  const subtotal = cents(lines.reduce((s, l) => s + l.amount, 0));
  const discount = cents(subtotal * ((args.discountPct ?? 0) / 100));
  const taxable  = cents(subtotal - discount);
  const tax      = cents(taxable * ((args.taxRate ?? 0) / 100));
  const total    = cents(taxable + tax);
  return { lines, subtotal, discount, taxable, tax, total };
}

/**
 * ₹ figure → the customer's currency, for a DOCUMENT (invoice, its PDF) that prints its own
 * stored ₹ figures. When the document covers the lines whole (their ₹ taxable is the
 * document's taxable), its subtotal / taxable / tax / total and each line's rate and amount
 * map to foreignQuoteFigures — so an invoice shows the same $338.40 the quote and the accept
 * page asked for. Any other figure (an advance, a part-period instalment) is ₹ ÷ rate, to the cent.
 */
export function foreignDocConverter(args: {
  lines: readonly ForeignLineIn[];
  fx: number;
  discountPct?: number | null;
  taxRate?: number | null;
  inr: { subtotal: number; taxable: number; tax: number; total: number };
}): (inr: number) => number {
  const fx = args.fx > 0 ? args.fx : 1;
  const known = new Map<number, number>();
  const oldLinesInr = args.lines.reduce((s, l) => {
    const gross = l.qty * l.rate;
    return s + Math.round(gross - gross * ((l.discount_pct ?? 0) / 100));
  }, 0);
  /* R-2637: the whole-rupee line totals the builder saves (rounded once per line). The old
     sum is still accepted so a document saved before R-2637 maps exactly as it did. */
  const taxableOf = (linesInr: number) => linesInr - Math.round(linesInr * ((args.discountPct ?? 0) / 100));
  const covers = taxableOf(linesInrSubtotal(args.lines)) === args.inr.taxable
    || taxableOf(oldLinesInr) === args.inr.taxable;
  if (args.lines.length > 0 && covers) {
    const f = foreignQuoteFigures({ lines: args.lines, fx, discountPct: args.discountPct, taxRate: args.taxRate });
    args.lines.forEach((l, i) => {
      known.set(l.rate, f.lines[i].unit);
      known.set(l.qty * l.rate, f.lines[i].gross);
      known.set(lineInr(l), f.lines[i].gross);
    });
    known.set(args.inr.subtotal, f.subtotal);
    known.set(args.inr.taxable, f.taxable);
    known.set(args.inr.tax, f.tax);
    known.set(args.inr.total, f.total);
  }
  return (inr: number) => known.get(inr) ?? cents(inr / fx);
}

/* ── R-2637: a foreign price → the ₹ books, rounded ONCE at the line total ─────────────────
   The builder used to store each line's ₹ unit rate as Math.round(usd × fx): 10 seats × $2 @
   95.10 became 10 × ₹190 = ₹1,900, while the customer paid $20 = ₹1,902 (bank / FIRA). Now the
   ₹ unit rate keeps the exact product (USD has cents, the rate ≤ 4 decimals → ≤ 6 decimals),
   and the ₹ LINE total is round(qty × rate) — the same per-line round() the SQL readers use
   (combine_quotes, quote_one_time_lines). Whole-rupee rates (every INR quote) are unchanged. */

/** Round to 6 decimals — removes float noise (5 × 190.1 = 950.4999…) before a rupee round. */
function r6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Half away from zero, like SQL round() on numeric. */
function roundRupee(v: number): number {
  const x = r6(v);
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** ₹ per unit from a price in the customer's currency — NOT rounded to whole rupees. */
export function inrRateFromForeign(foreign: number, fx: number): number {
  if (!Number.isFinite(foreign) || !Number.isFinite(fx)) return 0;
  return r6(foreign * fx) || 0;
}

/** The line's ₹ total (before its own legacy discount_pct): round(qty × rate), once. */
export function lineInr(l: { qty: number; rate: number }): number {
  return roundRupee(l.qty * l.rate) || 0;
}

/** Σ line ₹ totals less each line's legacy discount_pct — the quote's whole-rupee subtotal. */
export function linesInrSubtotal(lines: readonly ForeignLineIn[]): number {
  return lines.reduce(
    (s, l) => s + lineInr(l) - (roundRupee(l.qty * l.rate * ((l.discount_pct ?? 0) / 100)) || 0),
    0,
  );
}
