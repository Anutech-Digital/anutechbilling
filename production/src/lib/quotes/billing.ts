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
import { isOneTimeQuote } from "./service-period";

export const BILLING_CYCLE_OPTIONS: { id: BillingCycle; label: string }[] = [
  { id: "yearly",      label: "Annual — 1 invoice/yr (popular)" },
  { id: "half_yearly", label: "Half-yearly — 2 invoices/yr" },
  { id: "quarterly",   label: "Quarterly — 4 invoices/yr" },
  { id: "monthly",     label: "Monthly — 12 invoices/yr" },
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

/**
 * R-1715: the unit after a quote's total on /quotes — "/mo", "/yr", or nothing. A one-time
 * charge (add seats pro-rata, a direct invoice, a month extension) is paid once, so it carries
 * no period: "₹1,006/yr" on a pro-rata quote read as a yearly charge. No billing_cycle → nothing
 * (a guessed unit is the same wrong-unit bug).
 */
export function quoteTotalUnit(q: {
  billing_cycle?: string | null;
  is_add_seats?: boolean | null;
  is_one_off?: boolean | null;
  is_extension?: boolean | null;
  extension_months?: number | null;
}): string {
  if (isOneTimeQuote({ isAddSeats: q.is_add_seats, isOneOff: q.is_one_off, isExtension: q.is_extension, extensionMonths: q.extension_months })) return "";
  return q.billing_cycle === "monthly" ? "/mo" : q.billing_cycle === "yearly" ? "/yr" : "";
}

/** R-1715: the extension badge — "Ext · 3 months" (was "Ext · 0yr"), "Ext · 1 yr" for whole years. */
export function extensionBadgeLabel(months: number | null | undefined): string {
  const m = typeof months === "number" && months > 0 ? Math.round(months) : 12;
  if (m % 12 === 0) return `Ext · ${m / 12} yr`;
  return `Ext · ${m} ${m === 1 ? "month" : "months"}`;
}
