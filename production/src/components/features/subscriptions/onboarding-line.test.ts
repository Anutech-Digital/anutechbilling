/**
 * R-1442 — Onboard subscription → "Payment Received": the Start Date typed in the dialog was
 * dropped. The quote line carried no start_date, so record_payment started the subscription
 * on current_date (migration r1703, `coalesce(line start_date, current_date)`) and the
 * renewal date followed today, not the back-dated start (Pratik, staging 14 Oct).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { onboardingQuoteLine } from "./onboarding-line";
import { billingTerms } from "@/lib/subscriptions/catalog-options";

describe("R-1442 onboarding quote line keeps the chosen start date", () => {
  const terms = billingTerms("annual_yearly");
  it("a back-dated start (1 Sep 2026) is on the line record_payment reads", () => {
    const line = onboardingQuoteLine({ id: "line-1", plan: "Workspace Starter", seats: 5, pricePerSeat: 1500, terms, startDate: "2026-09-01" });
    expect(line.start_date).toBe("2026-09-01");
    expect(line.qty).toBe(5);
    expect(line.rate).toBe(1500);
    expect(line.commitment).toBe("annual_yearly");
  });
  it("a blank start leaves the field off (record_payment then uses its own default)", () => {
    const line = onboardingQuoteLine({ id: "line-1", plan: "X", seats: 1, pricePerSeat: 100, terms, startDate: "  " });
    expect(line.start_date).toBeUndefined();
  });
  it("the dialog builds its line with it", () => {
    const src = readFileSync("src/components/features/subscriptions/add-subscription-dialog.tsx", "utf8");
    expect(src).toMatch(/onboardingQuoteLine\(\{[\s\S]{0,200}?startDate, renewalDate \}\)/);
  });
  /* R-1442 follow-up (R-1445 migration): the Renewal / Expiry date on screen — default or
     hand-edited — rides on the line; trigger subscription_term_follows_line uses it on the
     paid path, where record_payment used to write start + 1 year whatever the form said. */
  it("carries the Renewal / Expiry date when it is after the start", () => {
    const line = onboardingQuoteLine({ id: "l", plan: "X", seats: 1, pricePerSeat: 100, terms, startDate: "2026-09-01", renewalDate: "2029-08-31" });
    expect(line.renewal_date).toBe("2029-08-31");
  });
  it("drops a renewal date that is blank or not after the start", () => {
    expect(onboardingQuoteLine({ id: "l", plan: "X", seats: 1, pricePerSeat: 100, terms, startDate: "2026-09-01", renewalDate: "" }).renewal_date).toBeUndefined();
    expect(onboardingQuoteLine({ id: "l", plan: "X", seats: 1, pricePerSeat: 100, terms, startDate: "2026-09-01", renewalDate: "2026-09-01" }).renewal_date).toBeUndefined();
  });
});

/* R-2734 (Pratik, 16 Oct): "client ne 3 saal ki payment ki hai toh 1 yr se zyada ka option hi nahi
   raha". A domain item in the Onboard dialog can be "Register for N years". The price box stays
   PER YEAR (as R-2712's Bulk dialog); the line carries the whole term like a quote's multi-year
   domain line (R-156 / R-1445), and NO renewal_date — trigger subscription_term_follows_line then
   sets renewal = start + N years AND spreads the mrr over the years (a line renewal_date would skip
   that and leave mrr at the whole term ÷ 12). */
import { onboardingYears } from "./onboarding-line";

describe("R-2734 onboarding line for a domain registered for N years", () => {
  const terms = billingTerms("annual_yearly");
  const base = { id: "l", plan: "Domain .in", seats: 1, pricePerSeat: 800, terms, startDate: "2025-04-01", renewalDate: "2026-04-01" };

  it("3 years: rate and cost are the whole term, years on the line, start kept, no renewal_date", () => {
    const line = onboardingQuoteLine({ ...base, years: 3, terms: { ...terms, costPerSeat: 600 } });
    expect(line.rate).toBe(2400);
    expect(line.cost).toBe(1800);
    expect(line.qty).toBe(1);
    expect(line.years).toBe(3);
    expect(line.start_date).toBe("2025-04-01");
    expect(line.renewal_date).toBeUndefined();
    expect(line.commitment).toBe("annual_yearly");
    /* Registrar: no domain on the line, so provisioning queues no registration (as before). */
    expect((line as { domain?: string }).domain).toBeUndefined();
  });

  it("1 year (or no years): exactly the line it always was — rate = price, the typed renewal date rides", () => {
    for (const years of [undefined, 1]) {
      const line = onboardingQuoteLine({ ...base, years });
      expect(line.rate).toBe(800);
      expect(line.years).toBeUndefined();
      expect(line.renewal_date).toBe("2026-04-01");
    }
  });

  it("years outside 1-10 or not whole → 1 year (the domainLineYears / trigger rule)", () => {
    for (const years of [0, 11, 2.5, Number.NaN, -3]) {
      const line = onboardingQuoteLine({ ...base, years });
      expect(line.rate).toBe(800);
      expect(line.years).toBeUndefined();
    }
  });

  it("years never apply to a split-billed or flex line (whole-year terms, billed once)", () => {
    for (const choice of ["annual_monthly", "annual_quarterly", "annual_half_yearly", "monthly_flex"] as const) {
      const t = billingTerms(choice);
      const line = onboardingQuoteLine({ ...base, terms: t, pricePerSeat: 70, years: 3 });
      expect(line.years).toBeUndefined();
      expect(line.rate).toBe(70 * t.periods);
    }
  });

  it("onboardingYears: only a domain plan on Annual · Yearly gets N years", () => {
    expect(onboardingYears(3, { domainPlan: true, billingChoice: "annual_yearly" })).toBe(3);
    expect(onboardingYears(3, { domainPlan: false, billingChoice: "annual_yearly" })).toBe(1);
    expect(onboardingYears(3, { domainPlan: true, billingChoice: "annual_monthly" })).toBe(1);
    expect(onboardingYears(3, { domainPlan: true, billingChoice: "monthly_flex" })).toBe(1);
    expect(onboardingYears(12, { domainPlan: true, billingChoice: "annual_yearly" })).toBe(1);
  });

  it("onboardingRenewal: start + N years (29 Feb 2028 + 3 → 28 Feb 2031, as Postgres); 1 year keeps the typed date", async () => {
    const { onboardingRenewal } = await import("./onboarding-line");
    expect(onboardingRenewal("2025-04-01", 3, "2026-05-05")).toBe("2028-04-01");
    expect(onboardingRenewal("2028-02-29", 3, "")).toBe("2031-02-28");
    expect(onboardingRenewal("2025-04-01", 1, "2026-05-05")).toBe("2026-05-05");
    expect(onboardingRenewal("", 3, "2026-05-05")).toBe("2026-05-05");
  });
});

/* R-2734: the Onboard dialog priced a PER-YEAR catalogue item (R-526 billing_unit unit_year — a
   domain registration) as per month × 12: ₹800 a year showed ₹9,600/yr, so "catalogue price × 3
   years" would have been ₹28,800. The dialog now takes such an item's yearly price and cost the way
   every quote adder does (catalogYearlyPrice) — as R-2712 did in the Bulk dialog. */
import { yearlyUnitProducts } from "./onboarding-line";
import { subscriptionProducts } from "@/lib/subscriptions/catalog-options";
import type { Item } from "@/lib/supabase/database.types";

describe("R-2734 per-year catalogue items in the Onboard dialog", () => {
  const domain = { id: "d", name: "Domain .in", vendor: "domain", item_type: "subscription", is_active: true,
    msrp: 800, wholesale: 600, prices: { billing_unit: "unit_year" } } as unknown as Item;
  const gws = { id: "g", name: "Google Workspace Business Standard", vendor: "google", item_type: "subscription", is_active: true,
    msrp: 300, wholesale: 264, prices: { annual: { msrp: 300, wholesale: 264 } } } as unknown as Item;

  it("a unit_year item is ₹800 / ₹600 a year (not × 12); its monthly figures are the year ÷ 12", () => {
    const [p] = yearlyUnitProducts(subscriptionProducts([domain]), [domain]);
    expect(p.annualSellPerSeat).toBe(800);
    expect(p.annualCostPerSeat).toBe(600);
    expect(p.annualMonthlySellPerSeat).toBe(67);
    expect(p.annualMonthlyCostPerSeat).toBe(50);
    expect(billingTerms("annual_yearly", p).suggestedSellPerSeat).toBe(800);
  });

  it("a per-month item (Workspace) is untouched", () => {
    const before = subscriptionProducts([gws]);
    expect(yearlyUnitProducts(before, [gws])).toEqual(before);
  });
});

describe("R-2734 review fixes", () => {
  const terms = billingTerms("annual_yearly");
  it("the line carries the catalogue item (record_payment reads the vendor from it); a custom plan has none", () => {
    expect(onboardingQuoteLine({ id: "l", itemId: "dom-in", plan: "Domain .in", seats: 1, pricePerSeat: 800, terms, startDate: "2025-04-01" }).item_id).toBe("dom-in");
    expect(onboardingQuoteLine({ id: "l", itemId: null, plan: "X", seats: 1, pricePerSeat: 800, terms, startDate: "2025-04-01" }).item_id).toBeUndefined();
  });
  it("custom plan cost guess is rounded once on the whole term (799 × 3 × 0.83 = 1,990)", () => {
    const line = onboardingQuoteLine({ id: "l", plan: "Domain .in", seats: 1, pricePerSeat: 799, terms: { ...terms, costPerSeat: null }, startDate: "2025-04-01", years: 3 });
    expect(line.cost).toBe(1990);
  });
  it("after the per-year fix the cheapest plan of a vendor still comes first", () => {
    const yearly = { id: "s-y", name: "Support yearly", vendor: "support", item_type: "subscription", is_active: true,
      msrp: 6000, wholesale: 0, prices: { billing_unit: "unit_year" } } as unknown as Item;
    const monthly = { id: "s-m", name: "Support monthly", vendor: "support", item_type: "subscription", is_active: true,
      msrp: 1000, wholesale: 0, prices: {} } as unknown as Item;
    const list = yearlyUnitProducts(subscriptionProducts([yearly, monthly]), [yearly, monthly]);
    expect(list.map((p) => p.id)).toEqual(["s-y", "s-m"]);   // ₹6,000/yr before ₹12,000/yr
  });
});
