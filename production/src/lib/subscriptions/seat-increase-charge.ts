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

/**
 * R-543 — a seat increase whose effective date is in the PREVIOUS term: two parts on one quote,
 * each priced by seatIncreaseCharge() (same annual per seat, same paise engine, same tax).
 *   previous — the rest of the previous term (days over the previous term's length);
 *   current  — the current term from its start (what a current-term-start date charges).
 * The quote's subtotal and amount are the parts added in PAISE and rounded once, so the two
 * lines cannot drift a rupee from the total. With no previous part this is exactly
 * seatIncreaseCharge() — the quote for a current-term date is unchanged.
 * addSeats() and the Add seats dialog both call it (R-803 rule: preview = server).
 */
export interface SeatIncreaseQuoteInput extends Omit<SeatIncreaseChargeInput, "remainingDays" | "termDays"> {
  previous?: { remainingDays: number; termDays: number } | null;
  current: { remainingDays: number; termDays: number };
}

export interface SeatIncreaseQuote {
  annualPerSeat: number;
  previous: SeatIncreaseCharge | null;
  current: SeatIncreaseCharge;
  /** Ex-GST, whole rupees — the quote's `subtotal`. */
  subtotal: number;
  /** total − subtotal. */
  tax: number;
  /** Incl. GST, whole rupees — the quote's `amount`. */
  total: number;
  newMrr: number;
}

export function seatIncreaseQuote(input: SeatIncreaseQuoteInput): SeatIncreaseQuote {
  const { previous: prevDays, current: curDays, ...base } = input;
  const current = seatIncreaseCharge({ ...base, remainingDays: curDays.remainingDays, termDays: curDays.termDays });
  if (!prevDays) {
    return {
      annualPerSeat: current.annualPerSeat, previous: null, current,
      subtotal: current.subtotal, tax: current.tax, total: current.total, newMrr: current.newMrr,
    };
  }
  const previous = seatIncreaseCharge({ ...base, remainingDays: prevDays.remainingDays, termDays: prevDays.termDays });
  const subtotal = paiseToRupees(previous.proration.subtotalPaise + current.proration.subtotalPaise);
  const total    = paiseToRupees(previous.proration.totalPaise + current.proration.totalPaise);
  return {
    annualPerSeat: current.annualPerSeat, previous, current,
    subtotal, tax: total - subtotal, total, newMrr: current.newMrr,
  };
}
