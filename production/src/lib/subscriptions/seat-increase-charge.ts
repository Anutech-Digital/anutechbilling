/**
 * R-803 — the ONE calculation of what a mid-term seat increase charges, in whole rupees.
 *
 * addSeats() (the server, which writes the quote) and every preview of the same charge —
 * the Add seats dialog, the seat-requests approval card — call this, so a preview can no
 * longer disagree with the quote it turns into.
 *
 * Why this exists: on 10 Oct the dialog showed ₹853 + ₹154 GST = ₹1,007 while the quote it
 * created (Q-F588-27-0004, ₹1,656/seat/yr, 188 of 365 days, 1 seat) said ₹1,006. The server
 * works in paise and rounds the TOTAL once (₹852.95 + ₹153.53 = ₹1,006.48 → ₹1,006); the
 * dialog rounded subtotal and GST to rupees separately and added the two rounded figures.
 *
 * The rules, all copied from what the server has always done (not changed here):
 *   - annual price per seat = round(mrr × 12 ÷ seats) in whole rupees — what THIS customer pays;
 *   - prorate() in integer paise, rounded once;
 *   - subtotal and total each rounded to whole rupees from paise (the quote's `subtotal`
 *     and `amount` columns);
 *   - GST shown = total − subtotal, so the three lines add up on screen and equal what the
 *     quote and the invoice built from it show (tax there is amount − taxable value).
 */
import { prorate, rupeesToPaise, paiseToRupees, type ProrationResult } from "./proration";

export interface SeatIncreaseChargeInput {
  /** Seats on the subscription before the change. */
  currentSeats: number;
  /** ₹/month the subscription bills now, for all current seats together. */
  currentMrr: number;
  /** Seats being added. */
  additionalSeats: number;
  /** Days charged for (seatChargeWindow().remainingDays, or days to term end). */
  remainingDays: number;
  /** Length of the current term in days (seatTermDays). */
  termDays: number;
  /** 18 domestic, 0 for a zero-rated export. */
  taxRatePct: number;
}

export interface SeatIncreaseCharge {
  /** ₹/seat/year the added seats are priced at. */
  annualPerSeat: number;
  /** Ex-GST, whole rupees — the quote's `subtotal`. */
  subtotal: number;
  /** GST, whole rupees — always total − subtotal. */
  tax: number;
  /** Incl. GST, whole rupees — the quote's `amount`. */
  total: number;
  /** Per-seat pro-rata rate for the quote line, display only. */
  perSeat: number;
  /** ₹/month the subscription bills after the change. */
  newMrr: number;
  /** The exact paise result, for notes and logs. */
  proration: ProrationResult;
}

export function seatIncreaseCharge(input: SeatIncreaseChargeInput): SeatIncreaseCharge {
  const { currentSeats, currentMrr, additionalSeats, remainingDays, termDays, taxRatePct } = input;

  const annualPerSeat = currentSeats > 0 ? Math.round((currentMrr * 12) / currentSeats) : 0;

  const proration = prorate({
    annualPerSeatPaise: rupeesToPaise(annualPerSeat),
    seats:              additionalSeats,
    remainingDays,
    termDays,
    taxRatePct,
  });

  const subtotal = paiseToRupees(proration.subtotalPaise);
  const total    = paiseToRupees(proration.totalPaise);

  return {
    annualPerSeat,
    subtotal,
    tax:     total - subtotal,
    total,
    perSeat: paiseToRupees(proration.perSeatPaise),
    newMrr:  Math.round((annualPerSeat * (currentSeats + additionalSeats)) / 12),
    proration,
  };
}
