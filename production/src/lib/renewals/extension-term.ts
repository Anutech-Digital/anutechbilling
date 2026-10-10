/**
 * R-805 (10 Oct 2026) — how long an "Extend term" adds, what it charges, and where the
 * renewal date lands. Shared by the Extend term dialog (preview) and createExtensionQuote
 * (the quote), so the two cannot disagree.
 *
 * Abhishek on staging: the dialog only offered 1, 2 or 3 years. Months (1, 3, 6 or any
 * 1–11) are now offered next to years.
 *
 * ─── YEARS — exactly as before ──────────────────────────────────────────────
 *   subtotal = round(mrr × 12 × years), total = grossAmount(subtotal, 18),
 *   renewal_date += years × 12 months (record_payment's old roll).
 *
 * ─── MONTHS ─────────────────────────────────────────────────────────────────
 *   Charge: annual price per seat × seats × months / 12, through the R-803 paise engine
 *   (seatIncreaseCharge with "days" = months over a 12-"day" term): annual per seat =
 *   round(mrr × 12 ÷ seats), subtotal and total each rounded once from paise, GST shown =
 *   total − subtotal (R-804 quoteDisplayTax rule), so the three lines always add up.
 *
 *   Date: the new INCLUSIVE last day = (first day of the following term + months) − 1 day.
 *   followingTermStart() reads both stored shapes — inclusive last day and the older
 *   anniversary rows — so both land on the right day. Adding months straight to an
 *   inclusive date goes wrong at month ends (30 Sep + 1 month = 30 Oct, but a term that
 *   started 1 Oct runs to 31 Oct), and adding months to an anniversary row gives a date
 *   that is neither shape, which the schedule then reads one day late. record_payment
 *   (migration 20261010090000) writes the same date.
 */
import { addMonthsClamped, addDaysISO } from "@/lib/billing/schedule";
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { grossAmount } from "@/lib/quotes/amounts";
import { seatIncreaseCharge } from "@/lib/subscriptions/seat-increase-charge";

/** Quick picks in the dialog. Any whole number 1–11 is allowed through "Custom". */
export const EXTENSION_MONTH_PRESETS = [1, 3, 6] as const;
export const EXTENSION_YEAR_PRESETS = [1, 2, 3] as const;
export const MAX_EXTENSION_MONTHS = 11;
export const MAX_EXTENSION_YEARS = 5;

export type ExtensionLength = { unit: "years"; count: number } | { unit: "months"; count: number };

/** Months the extension adds — what the quote stores as extension_months. */
export function extensionMonths(len: ExtensionLength): number {
  return len.unit === "years" ? Math.round(len.count * 12) : Math.round(len.count);
}

/** Null when valid, else a short reason. */
export function extensionLengthError(len: ExtensionLength): string | null {
  const n = len.count;
  if (!Number.isInteger(n)) return len.unit === "years" ? "Years must be a whole number" : "Months must be a whole number";
  if (len.unit === "years") return n >= 1 && n <= MAX_EXTENSION_YEARS ? null : `Years must be between 1 and ${MAX_EXTENSION_YEARS}`;
  return n >= 1 && n <= MAX_EXTENSION_MONTHS ? null : `Months must be between 1 and ${MAX_EXTENSION_MONTHS}`;
}

/** "3 months", "1 year". */
export function extensionLabel(len: ExtensionLength): string {
  const unit = len.unit === "years" ? "year" : "month";
  return `${len.count} ${unit}${len.count === 1 ? "" : "s"}`;
}

export interface ExtensionCharge {
  /** ₹/seat/year the extension is priced at. */
  annualPerSeat: number;
  /** Ex-GST, whole rupees — the quote's `subtotal`. */
  subtotal: number;
  /** total − subtotal. */
  tax: number;
  /** Incl. GST, whole rupees — the quote's `amount`. */
  total: number;
  /** Per-seat rate for the quote line, display only. */
  perSeat: number;
}

export function extensionCharge(args: { seats: number; mrr: number; len: ExtensionLength; taxRatePct?: number }): ExtensionCharge {
  const seats = Math.max(0, Math.round(args.seats));
  const mrr = Math.max(0, args.mrr ?? 0);
  const taxRatePct = args.taxRatePct ?? 18;

  if (args.len.unit === "years") {
    // Unchanged from before R-805.
    const subtotal = Math.max(0, Math.round(mrr * 12 * args.len.count));
    const total = grossAmount(subtotal, taxRatePct);
    return {
      annualPerSeat: Math.round((mrr * 12) / Math.max(1, seats)),
      subtotal,
      tax: total - subtotal,
      total,
      perSeat: Math.round(subtotal / Math.max(1, seats)),
    };
  }

  const c = seatIncreaseCharge({
    currentSeats: seats,
    currentMrr: mrr,
    additionalSeats: seats,
    remainingDays: args.len.count, // months …
    termDays: 12,                  // … over a 12-month year
    taxRatePct,
  });
  return { annualPerSeat: c.annualPerSeat, subtotal: c.subtotal, tax: c.tax, total: c.total, perSeat: c.perSeat };
}

/**
 * The renewal_date after the extension is paid — what record_payment writes.
 * Null without a renewal date.
 */
export function extensionRenewalDate(
  sub: { renewal_date: string | null; start_date: string | null; term_months: number | null },
  len: ExtensionLength,
): string | null {
  if (!sub.renewal_date) return null;
  const months = extensionMonths(len);
  if (len.unit === "years") return addMonthsClamped(sub.renewal_date.slice(0, 10), months);
  const shape = { renewal_date: sub.renewal_date, start_date: sub.start_date, term_months: sub.term_months ?? 12 };
  return addDaysISO(addMonthsClamped(followingTermStart(shape), months), -1);
}
