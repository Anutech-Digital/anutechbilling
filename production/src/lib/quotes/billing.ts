/**
 * Billing-cycle helpers — the single source of truth for how a quote-level
 * `billing_cycle` (invoice frequency) maps to invoices/year + display labels.
 *
 * Migration 0161 decoupled frequency (this, quote-level) from a line's
 * `commitment` (now the PRICE TIER: monthly-flex vs annual). Before this, four
 * files each carried their own `invoicesPerYear`/`billingUnitLabel` copies keyed
 * off the line commitment — which drifted and conflated the two concepts. Use
 * these instead, keyed off the quote's `billing_cycle`.
 *
 * NOTE: frequency is a stated schedule/label — it does not (yet) auto-generate N
 * invoices per year in the DB. `record_payment` still creates one annual
 * subscription for any committed (non-flex) sale; making cycles bill for real is
 * a separate future feature.
 */
import type { BillingCycle } from "@/lib/supabase/database.types";
import { BILLING_CYCLE_INVOICES_PER_YEAR } from "@/lib/supabase/database.types";

/* R-2048: "payments", not "invoices" — since R-2044 each part of a split year is a payment
   request first and is invoiced when paid (or on its date, for a customer with "Invoice on due
   date" ON — a payment either way). Shared by the quote builder, leads and bank reconcile. */
export const BILLING_CYCLE_OPTIONS: { id: BillingCycle; label: string }[] = [
  { id: "yearly",      label: "Annual — 1 payment/yr (popular)" },
  { id: "half_yearly", label: "Half-yearly — 2 payments/yr" },
  { id: "quarterly",   label: "Quarterly — 4 payments/yr" },
  { id: "monthly",     label: "Monthly — 12 payments/yr" },
];

/** Invoices raised per year for a billing cycle (yearly 1 … monthly 12). */
export function cycleInvoicesPerYear(cycle: BillingCycle | null | undefined): number {
  return BILLING_CYCLE_INVOICES_PER_YEAR[cycle ?? "yearly"] ?? 1;
}

/** Per-invoice unit suffix for a billing cycle ("/yr", "/half-yr", "/qtr", "/mo"). */
export function cycleUnitLabel(cycle: BillingCycle | null | undefined): string {
  switch (cycle ?? "yearly") {
    case "monthly":     return "/mo";
    case "quarterly":   return "/qtr";
    case "half_yearly": return "/half-yr";
    default:            return "/yr";
  }
}

/** Human schedule label for a billing cycle ("billed yearly", etc.). */
export function cycleScheduleLabel(cycle: BillingCycle | null | undefined): string {
  switch (cycle ?? "yearly") {
    case "monthly":     return "billed monthly";
    case "quarterly":   return "billed quarterly";
    case "half_yearly": return "billed half-yearly";
    default:            return "billed yearly";
  }
}

/**
 * Legacy bridge — derive a billing cycle from an old bundled line `commitment`
 * (for quotes written before 0161, or a line still carrying an annual_* value).
 * Flex "monthly" → monthly; annual_* → its frequency; else yearly.
 */
export function cycleFromLegacyCommitment(commitment: string | null | undefined): BillingCycle {
  switch (commitment) {
    case "monthly":
    case "annual_monthly":     return "monthly";
    case "annual_quarterly":   return "quarterly";
    case "annual_half_yearly": return "half_yearly";
    default:                   return "yearly";
  }
}

/**
 * R-1713: the term line under a quote line on /quotes/<id> — the line's price tier plus the
 * quote's REAL billing cycle. Q-0016 (billed quarterly) said "Annual commitment · billed per
 * year": the page read only the line's tier. An old quote with no billing_cycle falls back to
 * the line's legacy commitment, the same bridge the PDF uses.
 */
export function lineScheduleNote(commitment: string | null | undefined, cycle: BillingCycle | null | undefined): string {
  if (commitment === "monthly") return "Monthly, flexible · billed monthly";
  return `Annual commitment · ${cycleScheduleLabel(cycle ?? cycleFromLegacyCommitment(commitment))}`;
}

/* R-1715's quoteTotalUnit (billing_cycle only) is gone: it put "/mo" after an Annual sale's
   YEAR total. The /quotes list reads quoteRowTotalPeriods in lib/quotes/per-period-figures (R-2222). */

/** R-1715: the extension badge — "Ext · 3 months" (was "Ext · 0yr"), "Ext · 1 yr" for whole years. */
export function extensionBadgeLabel(months: number | null | undefined): string {
  const m = typeof months === "number" && months > 0 ? Math.round(months) : 12;
  if (m % 12 === 0) return `Ext · ${m / 12} yr`;
  return `Ext · ${m} ${m === 1 ? "month" : "months"}`;
}
