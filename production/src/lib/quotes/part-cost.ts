/**
 * R-2423 (4) — the vendor cost of a part's payment request, so its margin is known.
 *
 * A part request (R-2044) is made by the database with each line's cost 0, so the quote page read
 * "Est. margin: Unknown" although the subscription has a vendor cost (staging Q-A378-27-0930). The
 * cost is NOT a new rule: it is the subscription's own cost per seat per month (subscriptionCogs —
 * vendor bill first, then the catalogue, else unknown) × its seats × the part's months.
 *
 * Never a guess: the part must be whole months of its term (period_start/period_end on the term's
 * anchor — a short co-termed part is left unknown), and an unknown cost stays unknown (null).
 * Whole rupees (AGENTS.md §1). Existing lines are never rewritten — a line whose cost is already
 * known keeps it; only the page's margin reads this.
 */
import { subscriptionCogs } from "@/lib/vendor/cogs";
import { addMonthsClamped, CYCLE_MONTHS } from "@/lib/billing/schedule";
import type { BillingCycle, Item, Subscription } from "@/lib/supabase/database.types";

export interface PartPeriod {
  period_index: number;
  /** YYYY-MM-DD */
  period_start: string;
  /** YYYY-MM-DD, exclusive */
  period_end: string;
  term_start: string;
}

type CostSub = Pick<Subscription, "seats" | "mrr" | "item_id" | "vendor_cost_per_seat_month" | "vendor_synced_at" | "billing_cycle">
  & Partial<Pick<Subscription, "term_months">>;

/** Months the part covers — only when it is exactly one whole billing cycle on its term's anchor. */
export function partWholeMonths(part: PartPeriod, billingCycle: BillingCycle | string | null | undefined): number | null {
  const step = billingCycle ? CYCLE_MONTHS[billingCycle as BillingCycle] : undefined;
  if (!step || !Number.isInteger(part.period_index) || part.period_index < 1) return null;
  const start = addMonthsClamped(part.term_start, (part.period_index - 1) * step);
  const end = addMonthsClamped(part.term_start, part.period_index * step);
  return start === part.period_start.slice(0, 10) && end === part.period_end.slice(0, 10) ? step : null;
}

/** ₹ the part costs us (whole rupees), or null when it cannot be known. */
export function partVendorCost(sub: CostSub | null | undefined, part: PartPeriod | null | undefined, catalog: readonly Item[]): number | null {
  if (!sub || !part) return null;
  const months = partWholeMonths(part, sub.billing_cycle);
  if (months == null) return null;
  const cogs = subscriptionCogs(sub, catalog);
  if (cogs.source === "unknown" || cogs.monthlyCost == null) return null;
  return Math.round(cogs.monthlyCost * months);
}

interface CostLine { cost?: number | null; rate: number; qty?: number; billing_id?: string | null }

/**
 * The request's lines with a cost filled where it was unknown (≤ 0) and the part's cost is known.
 * A group request names each line's part (billing_id); a single-line request is the lead part.
 * Lines not filled stay as they are, so the shared unknown-cost rule (line-cost.ts) still decides.
 */
export function withPartCosts<L extends CostLine>(
  lines: readonly L[],
  leadBillingId: string | null | undefined,
  costOfBilling: (billingId: string) => number | null,
): L[] {
  return lines.map((l) => {
    if (l.cost != null && l.cost > 0) return l;
    const billingId = l.billing_id ?? (lines.length === 1 ? leadBillingId : null);
    if (!billingId) return l;
    const cost = costOfBilling(billingId);
    if (cost == null || cost <= 0) return l;
    /* The line's qty is 1 (one part); cost is per unit like every quote line. */
    const qty = l.qty && l.qty > 0 ? l.qty : 1;
    return { ...l, cost: Math.round(cost / qty) };
  });
}
