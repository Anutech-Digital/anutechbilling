import { describe, it, expect } from "vitest";
import { subscriptionProducts, findProduct, billingTerms } from "./catalog-options";
import { itemListMrr } from "./list-price-mrr";
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import type { Item } from "@/lib/supabase/database.types";

/**
 * R-1704 — the owner's real row (billing audit, 20 Oct 2026): the tenant's
 * "Google Workspace Business Starter" row still carries the OLD seed price ₹136/seat/month
 * (₹1,632/yr), below our own cost ₹3,080/yr. The quote builder lifts it to the R-205 list
 * price ₹270 (₹3,240/yr); Add Subscription offered ₹1,632 and the renewal quote copied it.
 * One rule: every place that prices a catalogue row goes through floorWorkspaceRow.
 */
const staleStarter = {
  id: "GW-STR-fbb", name: "Google Workspace Business Starter", vendor: "google",
  msrp: 136, wholesale: 256.67,
  prices: { annual: { msrp: 136, wholesale: 256.67 }, monthly: { msrp: 163, wholesale: 300 } },
  item_type: "subscription", kind: "main", is_active: true,
} as unknown as Item;

describe("R-1704 — Add Subscription prices Workspace like the quote builder (R-205 floor)", () => {
  const p = findProduct(subscriptionProducts([staleStarter]), "GW-STR-fbb")!;

  it("Business Starter suggests ₹3,240/yr, not the stale ₹1,632", () => {
    expect(p.annualSellPerSeat).toBe(3_240);
    expect(billingTerms("annual_yearly", p).suggestedSellPerSeat).toBe(3_240);
  });

  it("is the same yearly price the quote builder uses for the same row", () => {
    expect(p.annualSellPerSeat).toBe(catalogYearlyPrice(staleStarter).rate);
  });

  it("monthly-billed annual and flex are floored too (₹270/mo)", () => {
    expect(billingTerms("annual_monthly", p).suggestedSellPerSeat).toBe(270);
    expect(billingTerms("annual_quarterly", p).suggestedSellPerSeat).toBe(270);
    expect(p.flexMonthlySellPerSeat).toBe(270);
  });

  it("cost is never touched by the floor", () => {
    expect(p.annualMonthlyCostPerSeat).toBe(256.67);
  });

  it("a price ABOVE list is kept (a price rise still reaches the dialog)", () => {
    const raised = { ...staleStarter, msrp: 300, prices: { annual: { msrp: 300, wholesale: 256.67 } } } as unknown as Item;
    expect(findProduct(subscriptionProducts([raised]), "GW-STR-fbb")!.annualSellPerSeat).toBe(3_600);
  });

  it("imported subscriptions' list-price MRR uses the same floor (₹270 × seats)", () => {
    expect(itemListMrr(staleStarter as never, 10)).toBe(2_700);
  });
});
