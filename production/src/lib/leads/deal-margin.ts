/**
 * Gross margin on a lead or deal — what the reseller actually keeps.
 *
 * ─── WHERE THE COST COMES FROM ──────────────────────────────────────────────
 * `leads` has no cost column and no vendor column. It has `plan` (free text), `seats`
 * and `value`. So the cost is read from the CATALOG, using the same plan matching built
 * for subscriptions (lib/subscriptions/plan-match.ts) — real vendor prices, not a
 * percentage assumed off the sell price.
 *
 * That distinction is not academic. add-seats.ts derived cost as `sell × 0.83`, a flat
 * 17%, and on Business Starter that put ₹224 against a real ₹110. A margin figure built
 * on an assumed margin tells you nothing except what you assumed.
 *
 * ─── THE VENDOR PROBLEM, AND WHY AMBIGUITY REFUSES ──────────────────────────
 * matchPlan() keys on vendor + name precisely so hosting's ₹0 "Standard" can never price
 * a Google seat. A lead has no vendor, so this matches on NAME ALONE — and therefore
 * refuses whenever two vendors carry the same name. In this tenant "Standard" exists
 * under google, hosting and support; a lead whose plan is just "Standard" resolves to
 * `unknown`, not to whichever row happened to sort first.
 *
 * Real plan names ("Google Workspace Business Starter") are unambiguous and resolve
 * fine. Refusing on the rest is the whole safety property.
 *
 * ─── UNITS, WHICH ARE EASY TO GET 12× WRONG ─────────────────────────────────
 *     leads.value                    whole RUPEES, ANNUAL
 *                                    (add-lead-form: price × seats × 12)
 *     items.prices.annual.wholesale  ₹ per seat per MONTH
 * So annual cost = costPerSeatMonth × 12 × seats. Both confirmed in code, not assumed.
 */
import { planKey } from "@/lib/subscriptions/plan-match";
import type { Lead, Item } from "@/lib/supabase/database.types";

/**
 * Minimum margin a reseller should accept. 15% is the brief's figure and a PLACEHOLDER —
 * exported so the number lives in one visible place until somebody says what theirs is,
 * rather than being buried in a comparison.
 */
export const MARGIN_FLOOR_PCT = 15;

export type MarginBand = "loss" | "thin" | "ok" | "unknown";

export interface DealMargin {
  band: MarginBand;
  /** Annual cost in whole rupees. Null when the plan could not be priced. */
  costAnnual: number | null;
  /** value − cost, whole rupees. Null when cost is unknown. */
  grossAnnual: number | null;
  /** Margin on REVENUE, one decimal. Null when unknown. */
  marginPct: number | null;
  /** Why it could not be priced, for a message that names the actual problem. */
  reason: "ok" | "no_plan" | "no_seats" | "no_value" | "not_in_catalog" | "ambiguous_plan";
}

/** Cost per seat per month for one catalog row, in rupees. */
function monthlyCost(it: Pick<Item, "prices" | "wholesale">): number | null {
  const annual = (it.prices as { annual?: { wholesale?: number } } | null)?.annual?.wholesale;
  if (typeof annual === "number" && annual > 0) return annual;
  if (typeof it.wholesale === "number" && it.wholesale > 0) return it.wholesale;
  /* wholesale 0 is a genuine ₹0 for the reseller's own services (hosting, support) and
     "nobody filled it in" for a resold vendor. Leads sell resold products, so a zero here
     is treated as unknown rather than as a 100% margin on the row we know least about. */
  return null;
}

export interface PlanCostIndex {
  /** planKey → cost per seat per month, only where exactly one product matches. */
  costs: Map<string, number>;
  /** Keys carried by more than one product with different costs. */
  ambiguous: Set<string>;
}

/**
 * Build the name-only lookup.
 *
 * Two rows agreeing on a cost is harmless (a duplicate). Two rows disagreeing is
 * ambiguous, and ambiguous matches nothing — picking one would be a coin toss behind a
 * number somebody acts on.
 */
export function buildPlanCostIndex(items: readonly Item[]): PlanCostIndex {
  const costs = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const it of items) {
    if (it.item_type === "one_time") continue;
    const key = planKey(it.name);
    if (!key) continue;
    const cost = monthlyCost(it);
    if (cost === null) continue;

    const existing = costs.get(key);
    if (existing !== undefined && existing !== cost) { ambiguous.add(key); continue; }
    costs.set(key, cost);
  }
  for (const k of ambiguous) costs.delete(k);
  return { costs, ambiguous };
}

type MarginLead = Pick<Lead, "plan" | "seats" | "value">;

/**
 * Gross margin for one lead.
 *
 * Returns `unknown` rather than a number whenever any input is missing. A margin of 0%
 * and "we could not work it out" must never look the same on a screen — that confusion
 * is what let a hardcoded 17% pass for a measurement for months.
 */
export function dealMargin(
  lead: MarginLead,
  index: PlanCostIndex,
  floorPct: number = MARGIN_FLOOR_PCT,
): DealMargin {
  const unknown = (reason: DealMargin["reason"]): DealMargin =>
    ({ band: "unknown", costAnnual: null, grossAnnual: null, marginPct: null, reason });

  const value = lead.value ?? 0;
  if (value <= 0) return unknown("no_value");
  if (!lead.plan?.trim()) return unknown("no_plan");
  const seats = lead.seats ?? 0;
  if (seats <= 0) return unknown("no_seats");

  const key = planKey(lead.plan);
  if (index.ambiguous.has(key)) return unknown("ambiguous_plan");
  const perSeatMonth = index.costs.get(key);
  if (perSeatMonth === undefined) return unknown("not_in_catalog");

  const costAnnual = perSeatMonth * 12 * seats;
  const grossAnnual = value - costAnnual;
  // One decimal: a margin shown as 15.0% must not be a rounded 14.96% sitting under the floor.
  const marginPct = Math.round((grossAnnual / value) * 1000) / 10;

  return {
    band: grossAnnual < 0 ? "loss" : marginPct < floorPct ? "thin" : "ok",
    costAnnual,
    grossAnnual,
    marginPct,
    reason: "ok",
  };
}

/** Badge presentation, so every surface renders a margin identically. */
export function marginBadge(m: DealMargin): {
  label: string; kind: "danger" | "warning" | "muted" | "success"; title: string;
} {
  if (m.band === "unknown") {
    const why: Record<DealMargin["reason"], string> = {
      ok:              "",
      no_plan:         "No plan on this lead, so there is nothing to price.",
      no_seats:        "No seat count, so the cost cannot be worked out.",
      no_value:        "No deal value yet.",
      not_in_catalog:  "This plan has no row in Products, so its vendor cost is unknown.",
      ambiguous_plan:  "More than one catalogue product carries this name at different costs — it cannot be priced without a vendor.",
    };
    return { label: "—", kind: "muted", title: `Margin unknown. ${why[m.reason]}` };
  }
  const pct = `${m.marginPct!.toFixed(1)}%`;
  const detail = `Cost ₹${m.costAnnual!.toLocaleString("en-IN")}/yr from the catalogue.`;
  if (m.band === "loss") {
    return { label: pct, kind: "danger",
      title: `Below cost — this deal loses ₹${Math.abs(m.grossAnnual!).toLocaleString("en-IN")} a year. ${detail}` };
  }
  if (m.band === "thin") {
    return { label: pct, kind: "warning",
      title: `Under the ${MARGIN_FLOOR_PCT}% floor. ${detail}` };
  }
  return { label: pct, kind: "success", title: detail };
}
