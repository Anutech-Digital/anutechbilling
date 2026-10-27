/**
 * R-2020 (R-2019a, 27 Oct 2026): what the phone flow shows about money — all of it read from the
 * desktop's plans (_parts/tiers.ts buildTiers → _parts/plans.ts planSum, the server's sum).
 * Nothing here prices anything new: the saving is 12 monthly bills minus the yearly bill, both
 * from planSum; the compare rows are the desktop's COMPARE_ROWS, Starter and Standard columns.
 */
import { planSum, COMPARE_ROWS, type BuyPlan } from "../_parts/plans";

/** R-2019 decision 2: the phone sells Business Starter and Business Standard only. */
export function mobilePlans(plans: BuyPlan[]): BuyPlan[] {
  return plans.filter((p) => (p.id === "starter" || p.id === "standard") && p.annual != null && !p.priceHidden);
}

/** "Save ₹X" on Pay yearly: a year of monthly bills − the yearly bill (both incl. GST); null when monthly is not offered. */
export function yearlySaving(plan: BuyPlan, seats: number): number | null {
  const yearly = planSum(plan, seats, "annual");
  const monthly = planSum(plan, seats, "monthly");
  if (!yearly || !monthly) return null;
  const save = monthly.total * 12 - yearly.total;
  return save > 0 ? save : null;
}

export interface CompareRow { feature: string; starter: string; standard: string }

/** Starter vs Standard, from COMPARE_ROWS — rows where neither has the feature are left out. */
export function compareRows(): CompareRow[] {
  return COMPARE_ROWS
    .filter((r) => r.length > 1 && !(r[1] === "—" && r[2] === "—"))
    .map((r) => ({ feature: r[0], starter: r[1], standard: r[2] }));
}
