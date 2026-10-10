/**
 * R-826 — "Quarterly — annual commitment" in the 1-Click Onboard dialog.
 *
 * The rule pinned here: a quarterly deal is the ANNUAL rate, priced per seat per
 * MONTH, stored as the YEAR (periods 12), saved with billing_cycle 'quarterly' and
 * term_months 12 — the exact values the billing cron (plannedInstalments) and
 * quoteInstalments already split into four 3-month invoices. The sums below go
 * through those real functions, not a re-implementation of them.
 */
import { describe, it, expect } from "vitest";
import {
  subscriptionProducts, billingTerms, annualise, firstInvoiceTaxable, BILLING_CHOICES,
  type BillingChoice,
} from "./catalog-options";
import { plannedInstalments, quoteInstalments, isSplitBilled } from "@/lib/billing/instalments";
import { buildBillingSchedule, termEndInclusive, CYCLE_MONTHS } from "@/lib/billing/schedule";
import type { Item } from "@/lib/supabase/database.types";

const item = (over: Partial<Item> & { prices?: unknown } = {}): Item => ({
  id: "GW-STD", name: "Google Workspace Standard", vendor: "google",
  msrp: 864, wholesale: 620,
  prices: { annual: { msrp: 864, wholesale: 620 }, monthly: { msrp: 1_000, wholesale: 700 } },
  item_type: "subscription",
  ...over,
} as unknown as Item);

const product = subscriptionProducts([item()])[0];
const seats = 10;

describe("the dropdown offers Quarterly — annual commitment", () => {
  it("is listed with its label and a hint that names the unit and the cadence", () => {
    const q = BILLING_CHOICES.find((c) => c.value === "annual_quarterly");
    expect(q).toBeDefined();
    expect(q!.label).toBe("Quarterly — annual commitment");
    expect(q!.hint).toMatch(/per month/);
    expect(q!.hint).toMatch(/every 3 months/);
    expect(q!.hint).toMatch(/12 months/);
  });

  it("keeps the existing three choices, in order, with Yearly still first (the default)", () => {
    expect(BILLING_CHOICES.map((c) => c.value)).toEqual(
      ["annual_yearly", "annual_monthly", "annual_quarterly", "monthly_flex"]);
    expect(new Set(BILLING_CHOICES.map((c) => c.value)).size).toBe(BILLING_CHOICES.length);
  });
});

describe("billingTerms('annual_quarterly')", () => {
  const t = billingTerms("annual_quarterly", product);

  it("saves billing_cycle 'quarterly' — the value the cron splits — with a 12-month term", () => {
    expect(t.billingCycle).toBe("quarterly");
    expect(isSplitBilled(t.billingCycle)).toBe(true);
    expect(CYCLE_MONTHS[t.billingCycle]).toBe(3);
    expect(t.termMonths).toBe(12);
  });

  it("is the ANNUAL tier per month — not flex, not annual ÷ 12 of something else", () => {
    expect(t).toEqual({
      unit: "per_seat_month", unitLabel: "₹/mo",
      suggestedSellPerSeat: 864, costPerSeat: 620,
      flexPriceMissing: false,
      periods: 12, invoicesPerTerm: 4,
      commitment: "annual_yearly", billingCycle: "quarterly", termMonths: 12,
    });
    expect(t.suggestedSellPerSeat).not.toBe(product.flexMonthlySellPerSeat);
  });

  it("annualises like the other per-month choices, so the margin verdict is per year", () => {
    expect(annualise(t.suggestedSellPerSeat, t.unit)).toBe(10_368);
    expect(annualise(t.costPerSeat!, t.unit)).toBe(7_440);
  });

  it("a custom plan with no catalogue row suggests nothing and claims no cost", () => {
    const c = billingTerms("annual_quarterly", undefined);
    expect(c.suggestedSellPerSeat).toBe(0);
    expect(c.costPerSeat).toBeNull();
    expect(c.flexPriceMissing).toBe(false);
    expect(c.billingCycle).toBe("quarterly");
  });
});

describe("the money a 10-seat quarterly sale books", () => {
  const t = billingTerms("annual_quarterly", product);
  const perMonth = seats * t.suggestedSellPerSeat;       // what the dialog calls perPeriodAmount
  const stored   = perMonth * t.periods;                  // quotes.subtotal
  const mrr      = perMonth;                              // per_seat_month → mrr is the month

  it("stores the same year as Yearly would", () => {
    const yearly = billingTerms("annual_yearly", product);
    expect(stored).toBe(103_680);
    expect(stored).toBe(seats * yearly.suggestedSellPerSeat * yearly.periods);
  });

  it("MRR is the year ÷ 12", () => {
    expect(mrr).toBe(8_640);
    expect(mrr).toBe(stored / 12);
  });

  it("first invoice is one quarter: ₹25,920, and 4 of them make the year", () => {
    expect(firstInvoiceTaxable(stored, t)).toBe(25_920);
    expect(firstInvoiceTaxable(stored, t) * t.invoicesPerTerm).toBe(stored);
  });

  it("quoteInstalments splits the stored quote into exactly 4 equal quarters", () => {
    const qi = quoteInstalments({
      cycle: t.billingCycle, termTaxable: stored, termGross: Math.round(stored * 1.18),
      taxRate: 18, termMonths: t.termMonths, lineCommitment: t.commitment,
    });
    expect(qi).not.toBeNull();
    expect(qi!.count).toBe(4);
    expect(qi!.firstTaxable).toBe(25_920);
  });

  it("the cron lays 4 three-month instalments that sum to the year, ending on the term end", () => {
    const start = "2026-10-10";
    const renewal = termEndInclusive(start, t.termMonths);
    expect(renewal).toBe("2027-10-09");                    // start + 12 months, inclusive
    const plan = plannedInstalments({
      mrr, billing_cycle: t.billingCycle, term_months: t.termMonths,
      start_date: start, renewal_date: renewal,
    });
    expect(plan.map((p) => [p.periodStart, p.periodEnd, p.taxableAmount])).toEqual([
      ["2026-10-10", "2027-01-10", 25_920],
      ["2027-01-10", "2027-04-10", 25_920],
      ["2027-04-10", "2027-07-10", 25_920],
      ["2027-07-10", "2027-10-10", 25_920],
    ]);
    expect(plan.reduce((s, p) => s + p.taxableAmount, 0)).toBe(stored);
  });

  it("an odd price still sums to the year, remainder on the last quarter — and the dialog's first invoice matches the cron", () => {
    const odd = 7 * 833;                       // 7 seats × ₹833/mo
    const yearOdd = odd * t.periods;           // ₹69,972
    const sched = buildBillingSchedule({ startDate: "2026-10-10", termMonths: 12, cycle: "quarterly", termAmount: yearOdd });
    expect(sched).toHaveLength(4);
    expect(sched.reduce((s, p) => s + p.amount, 0)).toBe(yearOdd);
    expect(firstInvoiceTaxable(yearOdd, t)).toBe(sched[0].amount);
    /* Per-month pricing keeps mrr exact, so the cron's term (mrr × 12) IS the quote's. */
    expect(Math.round(odd * 12)).toBe(yearOdd);
  });
});

describe("existing choices are unchanged by R-826", () => {
  const expected: Record<Exclude<BillingChoice, "annual_quarterly">, object> = {
    annual_yearly: {
      unit: "per_seat_year", unitLabel: "₹/yr", suggestedSellPerSeat: 10_368, costPerSeat: 7_440,
      flexPriceMissing: false, periods: 1, invoicesPerTerm: 1,
      commitment: "annual_yearly", billingCycle: "yearly", termMonths: 12,
    },
    annual_monthly: {
      unit: "per_seat_month", unitLabel: "₹/mo", suggestedSellPerSeat: 864, costPerSeat: 620,
      flexPriceMissing: false, periods: 12, invoicesPerTerm: 12,
      commitment: "annual_yearly", billingCycle: "monthly", termMonths: 12,
    },
    monthly_flex: {
      unit: "per_seat_month", unitLabel: "₹/mo", suggestedSellPerSeat: 1_000, costPerSeat: 700,
      flexPriceMissing: false, periods: 1, invoicesPerTerm: 1,
      commitment: "monthly", billingCycle: "monthly", termMonths: 1,
    },
  };

  for (const [choice, terms] of Object.entries(expected)) {
    it(`${choice} returns exactly what it did before`, () => {
      expect(billingTerms(choice as BillingChoice, product)).toEqual(terms);
    });
  }

  it("first invoice: yearly = the year, monthly = one month, flex = the stored month", () => {
    expect(firstInvoiceTaxable(103_680, billingTerms("annual_yearly", product))).toBe(103_680);
    expect(firstInvoiceTaxable(103_680, billingTerms("annual_monthly", product))).toBe(8_640);
    expect(firstInvoiceTaxable(10_000, billingTerms("monthly_flex", product))).toBe(10_000);
  });

  it("annualise is unchanged", () => {
    expect(annualise(864, "per_seat_month")).toBe(10_368);
    expect(annualise(10_368, "per_seat_year")).toBe(10_368);
  });
});
