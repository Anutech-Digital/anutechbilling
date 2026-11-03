import { describe, expect, it } from "vitest";
import type { Item } from "@/lib/supabase/database.types";
import { anyCostUnknown } from "./line-cost";
import { partVendorCost, partWholeMonths, withPartCosts } from "./part-cost";

/* Q-A378-27-0930 shape: a monthly part request whose line cost the database wrote as 0, while the
   subscription has a vendor cost of ₹220/seat/month for 10 seats. */
const sub = {
  seats: 10, mrr: 2700, item_id: null, vendor_cost_per_seat_month: 220, vendor_synced_at: null,
  billing_cycle: "monthly" as const, term_months: 12,
};
const part = { period_index: 1, period_start: "2026-11-01", period_end: "2026-12-01", term_start: "2026-11-01" };

describe("partVendorCost — the subscription's own cost (subscriptionCogs) × the part's months", () => {
  it("monthly part: 220 × 10 seats × 1 month = ₹2,200", () => {
    expect(partVendorCost(sub, part, [])).toBe(2200);
  });

  it("quarterly part on its anchor: × 3", () => {
    expect(partVendorCost({ ...sub, billing_cycle: "quarterly" }, { ...part, period_index: 2, period_start: "2027-02-01", period_end: "2027-05-01" }, [])).toBe(6600);
  });

  it("a short (co-termed) part is not whole months → unknown, never a guess", () => {
    expect(partWholeMonths({ ...part, period_end: "2026-11-20" }, "monthly")).toBeNull();
    expect(partVendorCost(sub, { ...part, period_end: "2026-11-20" }, [])).toBeNull();
  });

  it("anchor on the 31st clamps like the schedule (31 Jan → 28 Feb → 31 Mar)", () => {
    expect(partWholeMonths({ period_index: 2, period_start: "2027-02-28", period_end: "2027-03-31", term_start: "2027-01-31" }, "monthly")).toBe(1);
  });

  it("no vendor cost and no catalogue row → unknown", () => {
    expect(partVendorCost({ ...sub, vendor_cost_per_seat_month: null }, part, [])).toBeNull();
  });

  it("catalogue fallback is the same rule as the subscriptions list (cogs.ts)", () => {
    const catalog = [{ id: "GWS-BS", wholesale: 0, prices: { annual: { wholesale: 110 } } }] as unknown as Item[];
    expect(partVendorCost({ ...sub, vendor_cost_per_seat_month: null, item_id: "GWS-BS" }, part, catalog)).toBe(1100);
  });
});

describe("withPartCosts — the page's margin is no longer Unknown", () => {
  it("single-line request: the lead part's cost fills the 0 cost", () => {
    const lines = [{ name: "Advance payment for month 1 · 1 Nov–30 Nov 2026", qty: 1, rate: 2700, cost: 0 }];
    expect(anyCostUnknown(lines)).toBe(true);
    const out = withPartCosts(lines, "b-1", (id) => (id === "b-1" ? 2200 : null));
    expect(out[0].cost).toBe(2200);
    expect(anyCostUnknown(out)).toBe(false);
  });

  it("group request: each line by its billing_id; an unknown one stays unknown", () => {
    const lines = [
      { qty: 1, rate: 2700, cost: 0, billing_id: "b-1" },
      { qty: 1, rate: 900, cost: 0, billing_id: "b-2" },
    ];
    const out = withPartCosts(lines, "b-1", (id) => (id === "b-1" ? 2200 : null));
    expect(out.map((l) => l.cost)).toEqual([2200, 0]);
    expect(anyCostUnknown(out)).toBe(true);
  });

  it("a cost already on the line is kept", () => {
    const lines = [{ qty: 1, rate: 2700, cost: 1500 }];
    expect(withPartCosts(lines, "b-1", () => 2200)[0].cost).toBe(1500);
  });
});
