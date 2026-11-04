/* R-2095 (30 Oct 2026, staging reconcile): Add seats showed ₹3,151/seat for a ₹3,150-a-year
   subscription. mrr is whole rupees, so 7 seats × ₹3,150 ÷ 12 = ₹1,837.50 → ₹1,838, and
   ₹1,838 × 12 ÷ 7 = ₹3,150.86 → ₹3,151. Both ₹3,150 and ₹3,151 give that mrr; the price is the
   round one, the price the subscription was sold at. */
import { describe, expect, it } from "vitest";
import { annualPerSeatFromMrr, seatIncreaseCharge } from "./seat-increase-charge";

describe("R-2095 the per-seat price behind a whole-rupee mrr", () => {
  it.each([
    [1838, 7, 3150],     // the staging case
    [5688, 35, 1950],    // Narmada, M365 Basic 35 × ₹1,950 (₹5,687.50 → 5,688)
    [263, 1, 3156],      // 1 seat: 263 × 12 = 3,156; no multiple of ₹10 within ₹1 → as before
    [2625, 10, 3150],    // exact
    [0, 5, 0],
  ])("mrr ₹%i over %i seats → ₹%i a seat a year", (mrr, seats, want) => {
    expect(annualPerSeatFromMrr(mrr, seats)).toBe(want);
  });
  it("the price always gives back the same mrr", () => {
    for (let seats = 1; seats <= 40; seats++) {
      for (const price of [1950, 3150, 3240, 11000, 1347]) {
        const mrr = Math.round((seats * price) / 12);
        const p = annualPerSeatFromMrr(mrr, seats);
        expect(Math.round((seats * p) / 12)).toBe(mrr);
      }
    }
  });
  it("Add seats charges the round price", () => {
    const c = seatIncreaseCharge({ currentSeats: 7, currentMrr: 1838, additionalSeats: 1, remainingDays: 365, termDays: 365, taxRatePct: 18 });
    expect(c.annualPerSeat).toBe(3150);
    expect(c.perSeat).toBe(3150);
  });
});
