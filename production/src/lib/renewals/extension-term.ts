/**
 * R-805 (10 Oct 2026) — how long an "Extend term" adds, what it charges, and where the
 * renewal date lands. Shared by the Extend term dialog (preview) and createExtensionQuote
 * (the quote), so the two cannot disagree.
 *
 * Abhishek on staging: the dialog only offered 1, 2 or 3 years. Months (1, 3, 6 or any
 * 1–11) are now offered next to years.
 *
 * ─── CHARGE (R-834) ─────────────────────────────────────────────────────────
 *   Per seat, whole rupees: annual per seat (round(mrr × 12 ÷ seats), the R-803 rule) ×
 *   years, or round(annual per seat × months / 12). subtotal = per seat × seats, so the
 *   quote line (rate × qty) IS the subtotal. total = grossAmount(subtotal, 18); GST shown =
 *   total − subtotal (R-804). Years: renewal_date += years × 12 months.
 *
 * ─── MONTHS — the date ──────────────────────────────────────────────────────
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
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";

/** Quick picks in the dialog. Any whole number 1–11 is allowed through "Custom". */
export const EXTENSION_MONTH_PRESETS = [1, 3, 6] as const;
export const EXTENSION_YEAR_PRESETS = [1, 2, 3] as const;
export const MAX_EXTENSION_MONTHS = 11;
export const MAX_EXTENSION_YEARS = 5;

export type ExtensionLength = { unit: "years"; count: number } | { unit: "months"; count: number };

/**
 * R-807 (10 Oct 2026): why this subscription cannot be extended at all — or null when it can.
 *
 * A subscription billed monthly / quarterly / half-yearly is invoiced per period by the
 * billing cron (subscription_billings, keyed by the CURRENT term = renewal_date − term).
 * Proven on the local DB (quarterly, 8 seats): the +1 year extension quote was paid
 * ₹30,586 and invoiced as one whole-year PAID invoice, then the cron laid the extended
 * year's four quarters and raised them as PENDING ₹7,646 each — raise_subscription_billing
 * only credits payments on the ORIGINAL quote, so ₹30,584 was demanded a second time.
 * And because paying moved renewal_date a year on, the cron's "current term" jumped to
 * the extended year, so the current year's unbilled quarters were never invoiced.
 *
 * Years were allowed after R-805 refused months; both are refused now. Server (extend
 * route) and dialog read this one function.
 */
export function extensionBlockedReason(cycle: BillingCycle | null | undefined): string | null {
  if (!isSplitBilled(cycle)) return null;
  const how = cycle === "half_yearly" ? "half-yearly" : cycle;
  return `This subscription is billed ${how}, so each part gets its own invoice on its date. An extension quote would bill the same months twice, so it cannot be extended.`;
}

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
  /** Ex-GST, whole rupees — the quote's `subtotal`. Always perSeat × seats (R-834). */
  subtotal: number;
  /** total − subtotal. */
  tax: number;
  /** Incl. GST, whole rupees — the quote's `amount`. */
  total: number;
  /** ₹ per seat for the whole extension, whole rupees — the quote line's `rate` (qty = seats). */
  perSeat: number;
}

/**
 * R-834 (10 Oct 2026): the line IS the price. Quote screens, the PDF and the accept page
 * show a line as rate × qty, so the subtotal is built from that line:
 *   perSeat  = annual per seat × years, or round(annual per seat × months / 12);
 *   subtotal = perSeat × seats; total = grossAmount(subtotal).
 * Before, years charged round(mrr × 12 × years) and months a paise pro-rata of all seats,
 * while the line carried a rounded per-seat figure "for display only" — Q-F588-27-0015
 * (10 seats, mrr ₹83) showed ₹100/yr × 10 = ₹1,000 over a ₹996 subtotal. Annual per seat
 * is the R-803 rule, round(mrr × 12 ÷ seats): mrr is stored rounded (₹1,000 ÷ 12 → ₹83),
 * so ₹100 × 10 is the customer's real price and ₹996 was the rounding error.
 * Saved quotes are untouched — only new extension quotes and the dialog preview use this.
 */
export function extensionCharge(args: { seats: number; mrr: number; len: ExtensionLength; taxRatePct?: number }): ExtensionCharge {
  const seats = Math.max(0, Math.round(args.seats));
  const mrr = Math.max(0, args.mrr ?? 0);
  const taxRatePct = args.taxRatePct ?? 18;
  const count = Math.max(0, Math.round(args.len.count));

  const annualPerSeat = seats > 0 ? Math.round((mrr * 12) / seats) : 0;
  const perSeat = args.len.unit === "years"
    ? annualPerSeat * count
    : Math.round((annualPerSeat * count) / 12);
  const subtotal = perSeat * seats;
  const total = grossAmount(subtotal, taxRatePct);
  return { annualPerSeat, subtotal, tax: total - subtotal, total, perSeat };
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
