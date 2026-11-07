/**
 * R-2226 (G-ZOHO Billing A2) — seats added to a subscription BILLED IN PARTS are priced at the
 * PART's own rate, not at the annual rate spread over the year's days.
 *
 * Zoho Billing audit, 31 Oct 2026: a monthly-billed seat at ₹3,240/yr bills ₹270 a month, but
 * adding one seat for a whole month cost ₹266 in a 30-day month and ₹275 in a 31-day month
 * (₹3,240 × 30 ÷ 365, × 31 ÷ 365). The customer saw two prices for the same seat, and the
 * rupee differences fought at reconcile. Now:
 *
 *   part rate per seat = annual per seat × months in the part ÷ 12        (₹270 for a month)
 *   charge per seat    = part rate × days left in the part ÷ days in the part
 *
 * so a whole part costs exactly one part's per-seat price, whatever its length in days. A
 * backdated date can reach back into earlier parts of the term (R-800 / R-543): each part is
 * charged at its own days, and the per-seat figure is rounded ONCE over the sum (integer
 * maths, BigInt — no float drift). Yearly-paid subscriptions keep annual × days ÷ term days.
 *
 * Pure. seatChargeParts() (seat-charge-window.ts) lays the segments; seatIncreaseCharge() and
 * addSeats() (quote line + vendor cost) price them here, so preview = quote (R-803 rule).
 */

/** One part (instalment) of the term the added seats are charged for. */
export interface SeatPartSegment {
  /** First day charged in this part (YYYY-MM-DD). */
  from: string;
  /** Last day charged in this part (inclusive, YYYY-MM-DD). */
  to: string;
  /** Days charged in this part — from `from` to the part's end. */
  days: number;
  /** Length of the whole part in days (28–31 for a month, 90–92 for a quarter, 181–184 for a half). */
  partDays: number;
  /** Months the part covers (1 monthly, 3 quarterly, 6 half-yearly; a short tail part fewer). */
  partMonths: number;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function clampDays(s: SeatPartSegment): number {
  return Math.max(0, Math.min(s.partDays, Math.round(s.days)));
}

/**
 * `perYear` (a whole number — rupees or paise) × Σ (partMonths × days ÷ partDays) ÷ 12, rounded
 * once, half away from zero. Each part's days are clamped to [0, partDays].
 */
export function partShareOf(perYear: number, parts: readonly SeatPartSegment[]): number {
  if (!Number.isSafeInteger(perYear)) throw new Error("partShareOf: perYear must be a whole number");
  let num = 0n;
  let den = 1n;
  for (const s of parts) {
    if (!(Number.isSafeInteger(s.partDays) && s.partDays > 0) || !(Number.isSafeInteger(s.partMonths) && s.partMonths > 0)) {
      throw new Error("partShareOf: partDays and partMonths must be positive whole numbers");
    }
    /* num/den += partMonths × days / partDays */
    const n = BigInt(s.partMonths * clampDays(s));
    const d = BigInt(s.partDays);
    num = num * d + n * den;
    den = den * d;
    const g = gcd(num, den) || 1n;
    num /= g;
    den /= g;
  }
  const top = BigInt(perYear) * num;
  const bottom = 12n * den;
  const neg = top < 0n;
  const abs = neg ? -top : top;
  const rounded = (2n * abs + bottom) / (2n * bottom);
  return Number(neg ? -rounded : rounded);
}

/** Days charged over all parts (after clamping). */
export function partDaysCharged(parts: readonly SeatPartSegment[]): number {
  return parts.reduce((sum, s) => sum + clampDays(s), 0);
}

/** One part's whole per-seat price, rounded to the rupee — for the formula line only. */
export function partRatePerSeat(annualPerSeat: number, partMonths: number): number {
  return Math.round((annualPerSeat * partMonths) / 12);
}

/**
 * The formula line the Add seats preview and the quote's staff note show, e.g.
 *   "Part rate ₹270/seat (1 month of ₹3,240/yr) × 15 of 30 days"
 * one clause per part, joined with " + ".
 */
export function partFormula(annualPerSeat: number, parts: readonly SeatPartSegment[], fmt: (n: number) => string): string {
  return parts.map((s) =>
    `Part rate ${fmt(partRatePerSeat(annualPerSeat, s.partMonths))}/seat (${s.partMonths} month${s.partMonths === 1 ? "" : "s"} of ${fmt(annualPerSeat)}/yr) × ${clampDays(s)} of ${s.partDays} days`,
  ).join(" + ");
}
