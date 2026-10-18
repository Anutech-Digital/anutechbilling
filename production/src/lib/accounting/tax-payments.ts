/**
 * Tax payments (GST, advance / self-assessment income tax) — the sums the books need.
 * Pure, so the balance sheet, the GST report and the ITR pack add them up one way.
 *
 * GST is tied to the RETURN MONTH it settles, not the day it was paid: March's GST
 * paid on 20 April belongs to March, and to the financial year March is in.
 * Income tax is tied to the financial year it was paid FOR.
 */

import { fyStartYear, fyLabelOfYear } from "@/lib/dates/ist";

export type TaxPaymentLike = {
  kind: "gst" | "advance_tax" | "self_assessment_tax";
  amount: number;
  period: string | null;   // YYYY-MM
  fy: string | null;       // YYYY-YY
};

/** 2026 → "2026-27" */
export function fyLabel(startYear: number): string {
  return fyLabelOfYear(startYear);
}

/** Start year of the Indian financial year an ISO date (or YYYY-MM) falls in. */
export function fyStartYearOf(isoDateOrPeriod: string): number {
  return fyStartYear(isoDateOrPeriod);
}

/** GST paid for return months in [fromPeriod, toPeriod] (YYYY-MM, inclusive). */
export function gstPaidForPeriods(payments: TaxPaymentLike[], fromPeriod: string, toPeriod: string): number {
  return payments
    .filter((p) => p.kind === "gst" && p.period !== null && p.period >= fromPeriod && p.period <= toPeriod)
    .reduce((s, p) => s + p.amount, 0);
}

/** GST paid for the returns of the financial year starting in `startYear`. */
export function gstPaidForFy(payments: TaxPaymentLike[], startYear: number): number {
  return gstPaidForPeriods(payments, `${startYear}-04`, `${startYear + 1}-03`);
}

/** Advance + self-assessment tax paid for the financial year starting in `startYear`. */
export function incomeTaxPaidForFy(payments: TaxPaymentLike[], startYear: number): number {
  const fy = fyLabel(startYear);
  return payments
    .filter((p) => (p.kind === "advance_tax" || p.kind === "self_assessment_tax") && p.fy === fy)
    .reduce((s, p) => s + p.amount, 0);
}
