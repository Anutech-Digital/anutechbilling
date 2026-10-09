/**
 * R-446: the first quote line built from a lead follows the lead's billing cycle.
 *
 * Abhishek, Scenario 3 (Verma Clinic, 3 × Business Starter, lead saved as Monthly): "Send
 * quote" built the line as "Annual (1-yr), ₹3,240/yr" and he had to switch it to Monthly
 * flex by hand. Forget that once and the customer gets a yearly quote for a monthly deal.
 *
 * The UNIT follows the commitment (lib/quotes/commitment-rate.ts): a `monthly` line's rate
 * is ₹/seat/MONTH, an annual line's is ₹/seat/YEAR. So a monthly lead takes the catalogue's
 * own monthly-flex tier when the item has one — the real price — and otherwise the same
 * unit conversion the builder's commitment picker already does (÷12). That converts a
 * unit; it does not invent a price.
 */
import { convertRateForCommitment } from "@/lib/quotes/commitment-rate";
import type { ItemPrices, LineCommitment } from "@/lib/supabase/database.types";

export interface LeadLinePrice {
  commitment: LineCommitment;
  /** ₹ per seat per YEAR for annual, per MONTH for monthly. */
  rate: number;
  cost: number;
  /** For the toast: "yr" or "mo". */
  unit: "yr" | "mo";
}

export function leadLinePrice(args: {
  /** leads.billing_cycle — "monthly" | "yearly" | null. */
  cycle: string | null | undefined;
  /** The annual line's rate and cost, ₹/seat/YEAR, as the builder already worked out. */
  annualRate: number;
  annualCost: number;
  /** The matched catalogue item's price tiers, when there is a catalogue item. */
  prices?: ItemPrices | null;
}): LeadLinePrice {
  if (args.cycle !== "monthly") {
    return { commitment: "annual_yearly", rate: args.annualRate, cost: args.annualCost, unit: "yr" };
  }
  const tier = args.prices?.monthly;
  if (tier && tier.msrp > 0) {
    return {
      commitment: "monthly",
      rate: Math.round(tier.msrp),
      cost: Math.max(0, Math.round(tier.wholesale ?? 0)),
      unit: "mo",
    };
  }
  const conv = convertRateForCommitment({
    rate: args.annualRate, cost: args.annualCost, from: "annual_yearly", to: "monthly",
  });
  return { commitment: "monthly", rate: conv.rate, cost: conv.cost, unit: "mo" };
}
