/**
 * R-369 — the ONE unit a quote line's `rate` (and `cost`) is stored in.
 *
 *   commitment "monthly" (flex)  → ₹ per seat per MONTH
 *   every annual_* commitment    → ₹ per seat per YEAR
 *
 * Every reader already assumed this: `lib/pdf/invoice-divisor.ts`, `lib/email/quote-body.ts`,
 * `lib/billing/instalments.ts`, the accept page, and `record_payment` /
 * `activate_quote_on_credit` (MRR = amount / 1.0 for a monthly line), with three SQL
 * regression tests behind it (see `commitment-rate.ts`). The writers did not: on 7 Oct 2026
 * the builder saved a flex line at `tier.msrp * 12` and a monthly support plan at
 * `term * 12`, while dividing every line by invoices-per-year on screen — so the builder
 * showed ₹2,040/month and the customer was sent "Payable each month ₹24,072".
 *
 * The builder now writes through `storedLineRate` and displays through
 * `perInvoiceDivisor`, so screen, saved row, PDF, e-mail and payment are one number.
 */
import { isAnnualTier } from "./commitment-rate";
import { perInvoiceDivisor } from "@/lib/pdf/invoice-divisor";
import type { LineCommitment } from "@/lib/supabase/database.types";

/** A ₹/seat/MONTH catalogue price → the `rate` a line with this commitment stores. */
export function storedLineRate(perSeatMonth: number, commitment: LineCommitment | null | undefined): number {
  const m = Number.isFinite(perSeatMonth) ? perSeatMonth : 0;
  return Math.round(isAnnualTier(commitment) ? m * 12 : m);
}

/**
 * What the quote's stored totals are divided by for the per-invoice figure. The PDF, the
 * preview and the e-mail decide by the FIRST line's commitment, so the builder must too, or
 * the screen and the document disagree.
 */
export function quoteTotalsDivisor(
  invoicesPerYear: number,
  lines: ReadonlyArray<{ commitment?: LineCommitment | null }>,
): number {
  return perInvoiceDivisor(invoicesPerYear, lines[0]?.commitment ?? null);
}

/** The unit after a line's AMOUNT (qty × rate) in the builder. */
export function lineAmountSuffix(commitment: LineCommitment | null | undefined, invoicesPerYear: number): string {
  if (!isAnnualTier(commitment)) return " /mo";
  return invoicesPerYear > 1 ? " /yr" : "";
}
