/**
 * The billing-period choice, and the 12× it is one mistake away from.
 *
 * ─── WHY THIS FILE IS MOSTLY ABOUT ONE NUMBER ───────────────────────────────
 * `billingTerms().periods` decides what the quote STORES, and the rule is not
 * symmetric:
 *
 *   monthly_flex    → 1   the stored figures ARE one month
 *   annual_monthly  → 12  the stored figures are the YEAR, split by quoteInstalments
 *   annual_yearly   → 1   one invoice, the year
 *
 * Get it backwards either way and money moves by 12×:
 *
 *  • `12` on flex re-creates the defect measured 1 Sep 2026 — a ₹5,753/month flex
 *    quote whose pay button asked for ₹479, because quoteInstalments divided figures
 *    that were already per-month. (lib/billing/instalments.ts documents that it
 *    returns null for commitment 'monthly' precisely to stop this.)
 *  • `1` on annual_monthly is the same bug inverted: instalments would divide an
 *    already-monthly amount by 12 and bill a twelfth of one month.
 *
 * The other thing pinned here is that FLEX IS ITS OWN PRICE. `prices.monthly` is a
 * higher rate, not `prices.annual`, and not annual ÷ 12. Substituting the annual rate
 * gives the flexibility premium away on every cancel-any-time deal, invisibly — so
 * when the catalogue has no flex price the terms must SAY so rather than pretend.
 */
import { describe, it, expect } from "vitest";
import { subscriptionProducts, billingTerms, annualise } from "./catalog-options";
import type { Item } from "@/lib/supabase/database.types";

/** A catalogue row shaped like the real ones: msrp/wholesale are ₹/seat/MONTH, and
 *  `prices.monthly` is the dearer flex tier. */
const item = (over: Partial<Item> & { prices?: unknown } = {}): Item => ({
  /* R-1704: not a Google Workspace name — GW rows are lifted to the R-205 list price, and
     this file pins billing-period arithmetic on a row priced as written. */
  id: "MS-STD", name: "Microsoft 365 Business Standard", vendor: "microsoft",
  msrp: 864, wholesale: 620,
  prices: { annual: { msrp: 864, wholesale: 620 }, monthly: { msrp: 1_000, wholesale: 700 } },
  item_type: "subscription",
  ...over,
} as unknown as Item);

const withFlex    = subscriptionProducts([item()])[0];
/** No `prices.monthly` — the shape hosting/support rows have. */
const withoutFlex = subscriptionProducts([item({ prices: { annual: { msrp: 864, wholesale: 620 } } })])[0];

describe("the catalogue exposes all three rates", () => {
  it("reads annual/year, annual/month and the dearer flex/month separately", () => {
    expect(withFlex.annualSellPerSeat).toBe(864 * 12);   // 10,368/yr
    expect(withFlex.annualMonthlySellPerSeat).toBe(864); //    864/mo committed
    expect(withFlex.flexMonthlySellPerSeat).toBe(1_000); //  1,000/mo flex — dearer
    expect(withFlex.flexMonthlyCostPerSeat).toBe(700);
  });

  it("reports a missing flex price as null rather than guessing", () => {
    expect(withoutFlex.flexMonthlySellPerSeat).toBeNull();
    expect(withoutFlex.flexMonthlyCostPerSeat).toBeNull();
  });
});

describe("periods — the number that is one mistake from a 12× error", () => {
  it("annual_yearly stores one period: the year", () => {
    expect(billingTerms("annual_yearly", withFlex).periods).toBe(1);
  });

  it("annual_monthly stores TWELVE — the year, for quoteInstalments to split", () => {
    expect(billingTerms("annual_monthly", withFlex).periods).toBe(12);
  });

  it("monthly_flex stores ONE — never 12; this is the 1 Sep 2026 defect", () => {
    expect(billingTerms("monthly_flex", withFlex).periods).toBe(1);
  });
});

describe("each choice's units, tiers and stored fields", () => {
  it("annual_yearly — ₹/yr, annual tier, one yearly invoice, 12-month term", () => {
    const t = billingTerms("annual_yearly", withFlex);
    expect(t).toMatchObject({
      unit: "per_seat_year", unitLabel: "₹/yr",
      suggestedSellPerSeat: 10_368, costPerSeat: 7_440,
      commitment: "annual_yearly", billingCycle: "yearly", termMonths: 12,
      flexPriceMissing: false,
    });
  });

  it("annual_monthly — ₹/mo at the ANNUAL rate, still a 12-month commitment", () => {
    const t = billingTerms("annual_monthly", withFlex);
    expect(t).toMatchObject({
      unit: "per_seat_month", unitLabel: "₹/mo",
      suggestedSellPerSeat: 864, costPerSeat: 620,
      commitment: "annual_yearly", billingCycle: "monthly", termMonths: 12,
    });
    /* The point of this row: monthly billing does NOT move it to the flex tier. */
    expect(t.suggestedSellPerSeat).not.toBe(withFlex.flexMonthlySellPerSeat);
  });

  it("monthly_flex — the flex tier's own rate, no commitment, 1-month term", () => {
    const t = billingTerms("monthly_flex", withFlex);
    expect(t).toMatchObject({
      unit: "per_seat_month", unitLabel: "₹/mo",
      suggestedSellPerSeat: 1_000, costPerSeat: 700,
      commitment: "monthly", billingCycle: "monthly", termMonths: 1,
      flexPriceMissing: false,
    });
    /* Flex is NOT the annual rate, and NOT annual ÷ 12. */
    expect(t.suggestedSellPerSeat).toBeGreaterThan(withFlex.annualMonthlySellPerSeat);
    expect(t.suggestedSellPerSeat).not.toBe(Math.round(withFlex.annualSellPerSeat / 12));
  });
});

describe("flex with no flex price — falls back, but says so", () => {
  const t = billingTerms("monthly_flex", withoutFlex);

  it("stands in the annual monthly rate so the field is not 0", () => {
    expect(t.suggestedSellPerSeat).toBe(864);
    expect(t.costPerSeat).toBe(620);
  });

  it("raises flexPriceMissing, so the screen can admit it is not a flex price", () => {
    expect(t.flexPriceMissing).toBe(true);
  });

  it("is still a real flex sale — commitment monthly, 1-month term, periods 1", () => {
    expect(t).toMatchObject({ commitment: "monthly", termMonths: 1, periods: 1 });
  });
});

describe("a custom plan with no catalogue row", () => {
  it("suggests nothing and claims no cost, on every choice", () => {
    for (const c of ["annual_yearly", "annual_monthly", "monthly_flex"] as const) {
      const t = billingTerms(c, undefined);
      expect(t.suggestedSellPerSeat).toBe(0);
      expect(t.costPerSeat).toBeNull();
      /* Not "missing" — there is no catalogue row to be missing a price. */
      expect(t.flexPriceMissing).toBe(false);
    }
  });
});

describe("annualise — so the margin verdict's 'per year' stays true", () => {
  it("scales a monthly rate and leaves a yearly one alone", () => {
    expect(annualise(864, "per_seat_month")).toBe(10_368);
    expect(annualise(10_368, "per_seat_year")).toBe(10_368);
  });
});

describe("the money a 10-seat sale actually books", () => {
  const seats = 10;

  it("yearly: contract and first invoice are the same ₹86,400", () => {
    const t = billingTerms("annual_yearly", withFlex);
    const perPeriod = seats * t.suggestedSellPerSeat;
    expect(perPeriod).toBe(103_680);
    expect(perPeriod * t.periods).toBe(103_680);
  });

  it("annual billed monthly: ₹8,640 this month, ₹1,03,680 committed", () => {
    const t = billingTerms("annual_monthly", withFlex);
    const perPeriod = seats * t.suggestedSellPerSeat;
    expect(perPeriod).toBe(8_640);              // asked for now
    expect(perPeriod * t.periods).toBe(103_680); // stored on the quote
  });

  it("flex: ₹10,000 this month and ₹10,000 stored — the same number", () => {
    const t = billingTerms("monthly_flex", withFlex);
    const perPeriod = seats * t.suggestedSellPerSeat;
    expect(perPeriod).toBe(10_000);
    /* If this ever reads 120,000 the flex 12× is back. */
    expect(perPeriod * t.periods).toBe(10_000);
  });
});
