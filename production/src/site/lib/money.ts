/**
 * Indian-format rupees, and the cart arithmetic — the handoff's formulas, verbatim:
 *
 *   gross    = Σ unitPrice × qty
 *   subtotal = gross − discount        (coupon applies to gross, BEFORE GST)
 *   gst      = subtotal × 0.18
 *   payable  = subtotal + gst
 *   recurring = Σ monthly lines, displayed × 1.18
 *
 * One module, because the drawer, the cart page and the checkout all show the same money —
 * three copies of this arithmetic is how a drawer total comes to disagree with the checkout
 * button, which on a commerce site is the least-forgivable class of bug.
 */
export function rupee(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

export type Cycle = "monthly" | "yearly" | "once";

export interface CartLine {
  /** Stable identity for steppers/removal. */
  key: string;
  label: string;
  detail: string;
  unitPrice: number;
  qty: number;
  /** What one unit is — "seat/month", "year", "mailbox". Renders as "40 × ₹736 per seat/month". */
  unit: string;
  cycle: Cycle;
  /**
   * Stable server-recognisable SKU, e.g. "hosting:standard". OPTIONAL and set by
   * the "Buy now" buttons. The checkout API re-prices every line from this SKU
   * server-side and NEVER trusts `unitPrice` from the client — a line without a
   * recognised SKU can't be charged online (it's sent to a quote instead).
   */
  sku?: string;
  /**
   * Domain lines only: the full name being registered ("acme.in"). The checkout
   * API refuses a `domain:<tld>` line without it — the name is what gets
   * registered, and a TLD alone ("Domain .in") told nobody which one was paid for.
   */
  domain?: string;
  /**
   * Domain lines only (R-156): the registration term picked, 1–10 (absent → 1), the total
   * price of each offered term as the search showed it, and whether the line was added as
   * the ₹0 domain bundled with yearly hosting (first year free, later years charged).
   * Display only — the checkout re-prices the term from the registry.
   */
  years?: number;
  yearPrices?: Record<string, number>;
  bundleFree?: boolean;
}

/** A domain line's price for a term: the term's total, less the free first year when bundled. */
export function domainTermPrice(yearPrices: Record<string, number> | undefined, years: number, bundleFree?: boolean): number | null {
  const total = yearPrices?.[String(years)];
  if (total === undefined) return null;
  if (!bundleFree) return total;
  return Math.max(0, total - (yearPrices?.["1"] ?? 0));
}

/*
 * Coupons: percent off the FIRST payment's gross, before GST.
 * R-225 (7 Oct 2026, Pardeep): code NAMES are never printed on the cart page, and a coupon
 * never discounts a `domain:*` line (a domain sells close to the registry's cost).
 * R-329 (7 Oct 2026): the code table is SERVER-ONLY (lib/checkout/coupons). This module is
 * in the browser bundle, so it only ever sees a rate the server confirmed
 * (POST /api/public/cart-coupon). Renewals are at list price.
 */

/** A line a coupon never discounts (R-225): a domain registration. */
export function isCouponExempt(sku: string | undefined): boolean {
  return (sku ?? "").toLowerCase().startsWith("domain:");
}

export interface CouponLineInput { qty: number; price: number; exempt: boolean }

/** One unit's price after the coupon, whole rupees — the "lines" mode of couponSplit. */
export function discountedUnitPrice(price: number, rate: number): number {
  return Math.round(price * (1 - rate));
}

/**
 * How a coupon comes off a cart — ONE rule for the cart page and the checkout (R-225):
 *
 *   "none"  — no valid code, or nothing in the cart it may discount (a domain-only cart).
 *   "whole" — no PRICED exempt line (a ₹0 bundled domain does not count): percent off the
 *             whole gross, exactly as before R-225. The quote stores it as `discount_pct`.
 *   "lines" — priced domain lines next to other lines. The discount comes off each other
 *             line's unit price, rounded to whole rupees (as a package discount does,
 *             lib/packages/price.ts), because a quote's `discount_pct` is a whole-number
 *             percent of the WHOLE subtotal and cannot leave the domain out.
 *
 * `discount` is rupees off, before GST. For "whole" it is unrounded, as the cart always
 * showed it; the checkout rounds the subtotal once.
 */
export function couponSplit(
  lines: readonly CouponLineInput[],
  rate: number,
): { mode: "none" | "whole" | "lines"; discount: number } {
  const eligible = lines.filter((l) => !l.exempt);
  const eligibleGross = eligible.reduce((n, l) => n + l.price * l.qty, 0);
  const exemptGross = lines.filter((l) => l.exempt).reduce((n, l) => n + l.price * l.qty, 0);
  if (rate <= 0 || eligibleGross <= 0) return { mode: "none", discount: 0 };
  if (exemptGross <= 0) return { mode: "whole", discount: eligibleGross * rate };
  return {
    mode: "lines",
    discount: eligible.reduce((n, l) => n + l.qty * (l.price - discountedUnitPrice(l.price, rate)), 0),
  };
}

export const GST_RATE = 0.18;

export interface CartTotals {
  gross: number;
  discountRate: number;
  discount: number;
  subtotal: number;
  gst: number;
  payable: number;
  /** Monthly-cycle lines only, pre-GST. The UI shows `recurring × 1.18` per month. */
  recurring: number;
}

/**
 * `couponRate` is the server-confirmed rate of the cart's code (0..1; 0 = none) — never the
 * code itself: the code table is not in the browser (R-329).
 */
export function cartTotals(lines: readonly CartLine[], couponRate: number): CartTotals {
  const gross = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const rate = Number.isFinite(couponRate) && couponRate > 0 && couponRate < 1 ? couponRate : 0;
  const { discount } = couponSplit(
    lines.map((l) => ({ qty: l.qty, price: l.unitPrice, exempt: isCouponExempt(l.sku) })),
    rate,
  );
  // Reported only when it took something off — a domain-only cart shows no "10% off" row.
  const discountRate = discount > 0 ? rate : 0;
  const subtotal = gross - discount;
  const gst = subtotal * GST_RATE;
  return {
    gross,
    discountRate,
    discount,
    subtotal,
    gst,
    payable: subtotal + gst,
    recurring: lines.filter((l) => l.cycle === "monthly").reduce((n, l) => n + l.unitPrice * l.qty, 0),
  };
}

/** "Recurring monthly" | "Renews yearly" | "One time" — the cart row's cycle label. */
/**
 * A line that is always exactly one: a free hosting trial (one per customer — a
 * "5 ×" trial is meaningless), a domain (one name is one registration; the
 * checkout already refuses a quantity above one) and a hosting plan (one plan is
 * one account on one domain; checkout sets up one hosting account per order, see
 * lib/checkout/hosting-limit.ts). No stepper is shown for these, adding one again
 * never bumps it, and a stored quantity is put back to 1.
 */
export function isSingleUnit(line: Pick<CartLine, "sku">): boolean {
  const sku = (line.sku ?? "").toLowerCase();
  return sku.startsWith("hosting-trial:") || sku.startsWith("domain:") || sku.startsWith("hosting:");
}

/**
 * Why a single-unit line is fixed at 1, in the words shown under its locked quantity
 * control (owner, 30 Sep 2026: "there should be a quantity option like others but it
 * should stay locked at 1"). Null for a line whose quantity can change.
 */
export function singleUnitNote(line: Pick<CartLine, "sku">): string | null {
  const sku = (line.sku ?? "").toLowerCase();
  if (sku.startsWith("hosting-trial:")) return "1 per customer";
  if (sku.startsWith("hosting:")) return "1 per order";
  if (sku.startsWith("domain:")) return "1 per domain";
  return null;
}

export function isTrialLine(line: Pick<CartLine, "sku">): boolean {
  return (line.sku ?? "").toLowerCase().startsWith("hosting-trial:");
}

export function cycleLabel(cycle: Cycle): string {
  return cycle === "monthly" ? "Recurring monthly" : cycle === "yearly" ? "Renews yearly" : "One time";
}
