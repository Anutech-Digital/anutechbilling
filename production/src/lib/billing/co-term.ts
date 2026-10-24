// Not wired yet — R-1608 (built, kept for later)
/**
 * Co-terming — making an add-on renew on the same day as the customer's main plan.
 *
 * ─── WHY IT MATTERS COMMERCIALLY ────────────────────────────────────────────
 * A customer with Workspace renewing on 1 April who buys a backup add-on on 20
 * September now has two renewal dates, two invoices, two chase sequences and two
 * chances to lapse. Co-terming charges the add-on only to 1 April — a short first
 * period — after which both renew together, for ever.
 *
 * ─── THE SHORT-STUB RULE IS A DECISION, NOT A DETAIL ────────────────────────
 * If the add-on is bought a few days before the anniversary, the aligned first period
 * is a few days long. Billing ₹43 for it, raising a GST invoice, and chasing payment
 * costs more than the money. So a stub shorter than MIN_STUB_DAYS is folded into the
 * FOLLOWING year instead: the customer gets those days free and the first invoice
 * covers a full year plus the stub.
 *
 * That is a giveaway, and it is deliberate and bounded — never more than 30 days of
 * one add-on. The alternative that looks tidier, charging the stub anyway, produces
 * an invoice a customer queries and a rep spends an hour explaining.
 *
 * ─── ALL ARITHMETIC GOES THROUGH prorate() ──────────────────────────────────
 * There is no second proration in this file. `prorate()` already rounds once, in
 * integer paise, and handles leap years by taking the real term length — writing
 * another one here is exactly how two parts of a system come to disagree about the
 * same charge.
 */
import { prorate, daysBetweenDates, rupeesToPaise, paiseToRupees } from "@/lib/subscriptions/proration";
import { addMonthsClamped, addDaysISO } from "./schedule";

/**
 * Below this, the stub is given away rather than invoiced. 30 days chosen because it
 * is one billing month — long enough that anything above it is a real period a
 * customer expects to pay for, short enough that the giveaway is bounded.
 */
export const MIN_STUB_DAYS = 30;

export interface CoTermInput {
  /** The main subscription's renewal date, YYYY-MM-DD. */
  anniversary: string;
  /** When the add-on starts, YYYY-MM-DD. */
  addOnStart: string;
  /** ₹ per seat for a FULL year, ex-GST. Whole rupees. */
  annualPerSeat: number;
  seats: number;
  /** GST percent. No default — an export is 0 and a domestic sale is 18. */
  taxRatePct: number;
}

export interface CoTermResult {
  /** The renewal date the add-on is aligned TO — always a real anniversary. */
  alignedTo: string;
  /** First period actually charged. */
  firstPeriodStart: string;
  firstPeriodEnd: string;
  chargedDays: number;
  /** Days in the year the stub is measured against — 365 or 366. */
  termDays: number;
  /** ₹ ex-GST for the first, aligned period. */
  firstChargeExGst: number;
  firstChargeTax: number;
  firstChargeTotal: number;
  /** True when the stub was too short to bill and was folded into the next year. */
  stubAbsorbed: boolean;
  /** Days given away by the short-stub rule. 0 unless stubAbsorbed. */
  freeDays: number;
  /** Plain language, for the quote line and the rep. */
  explanation: string;
}

/** The next occurrence of the anniversary on or after `from`. */
export function nextAnniversaryOnOrAfter(anniversary: string, from: string): string {
  let candidate = anniversary;
  /* Walk in whole years so 29 February clamps to 28 February in a common year
     rather than sliding to 1 March, which addMonthsClamped already handles. */
  let guard = 0;
  while (candidate < from && guard < 50) {
    candidate = addMonthsClamped(candidate, 12);
    guard++;
  }
  while (candidate >= from) {
    const prev = addMonthsClamped(candidate, -12);
    if (prev < from) break;
    candidate = prev;
  }
  return candidate;
}

/**
 * Work out the aligned first period and what to charge for it.
 *
 * Starting exactly ON the anniversary is a full year, not a zero-day stub — the
 * add-on and the main plan begin the same term together.
 */
export function coTerm(input: CoTermInput): CoTermResult {
  const { anniversary, addOnStart, annualPerSeat, seats, taxRatePct } = input;

  const nextAnniv = nextAnniversaryOnOrAfter(anniversary, addOnStart);
  /* The year the stub sits inside, measured in real days so a leap year is 366.
     prorate() takes termDays precisely so nobody hardcodes 365. */
  const yearStart = addMonthsClamped(nextAnniv, -12);
  const termDays = daysBetweenDates(yearStart, nextAnniv);

  let stubDays = daysBetweenDates(addOnStart, nextAnniv);
  let alignedTo = nextAnniv;
  let stubAbsorbed = false;
  let freeDays = 0;

  if (stubDays === 0) {
    /* Bought on the anniversary itself — a clean full term. */
    alignedTo = addMonthsClamped(nextAnniv, 12);
    stubDays = daysBetweenDates(addOnStart, alignedTo);
  } else if (stubDays < MIN_STUB_DAYS) {
    freeDays = stubDays;
    stubAbsorbed = true;
    alignedTo = addMonthsClamped(nextAnniv, 12);
    stubDays = daysBetweenDates(nextAnniv, alignedTo);
  }

  const charged = prorate({
    annualPerSeatPaise: rupeesToPaise(annualPerSeat),
    seats,
    remainingDays: stubDays,
    termDays: stubAbsorbed || stubDays >= termDays ? daysBetweenDates(addMonthsClamped(alignedTo, -12), alignedTo) : termDays,
    taxRatePct,
  });

  const firstPeriodStart = stubAbsorbed ? nextAnniv : addOnStart;
  const explanation = stubAbsorbed
    ? `Only ${freeDays} ${freeDays === 1 ? "day" : "days"} to ${fmt(nextAnniv)} — too short to invoice, so those days are free and billing starts ${fmt(nextAnniv)}, renewing with the main plan on ${fmt(alignedTo)}.`
    : `Charged ${charged.chargedDays} ${charged.chargedDays === 1 ? "day" : "days"} to ${fmt(alignedTo)} so it renews with the main plan.`;

  return {
    alignedTo,
    firstPeriodStart,
    firstPeriodEnd: alignedTo,
    chargedDays: charged.chargedDays,
    termDays,
    firstChargeExGst: paiseToRupees(charged.subtotalPaise),
    firstChargeTax:   paiseToRupees(charged.taxPaise),
    firstChargeTotal: paiseToRupees(charged.totalPaise),
    stubAbsorbed,
    freeDays,
    explanation,
  };
}

/** "20 Sep 2026" — the format the rest of the app shows dates in. */
function fmt(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Re-exported so callers building a co-termed schedule need one import. */
export { addDaysISO };
