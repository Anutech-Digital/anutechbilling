/**
 * R-2095 (coordinator 30 Oct, P0 money): an existing subscription's COMMITMENT could not be changed.
 * Venus Infotech is on Google Workspace ANNUAL commitment billed MONTHLY but was booked
 * "Monthly (Flexible)", so its licence cost was the Flexible ₹318/seat/month instead of the
 * annual-billed-monthly ₹264 and the list showed a false loss.
 */
import { describe, it, expect } from "vitest";
import {
  commitmentOf, frequenciesFor, catalogCostPerSeatMonth, commitmentRenewal, commitmentVerdict,
  COMMITMENT_OPTIONS,
} from "./commitment-change";
import { subscriptionCogs } from "@/lib/vendor/cogs";
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import type { Item, Subscription } from "@/lib/supabase/database.types";

/* The Venus product: Flexible costs ₹318/seat/month, annual commitment ₹264 (billed monthly or yearly). */
const ITEM = {
  id: "gws-std", wholesale: 264,
  prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } },
} as unknown as Item;

describe("commitment and billing frequency are two separate facts", () => {
  it("reads the commitment off term_months — 1 Flexible, 12 Annual, 36 three years", () => {
    expect(commitmentOf(1)).toBe("flex");
    expect(commitmentOf(12)).toBe("annual");
    expect(commitmentOf(null)).toBe("annual");
    expect(commitmentOf(36)).toBe("three_year");
    expect(COMMITMENT_OPTIONS.map((o) => o.months)).toEqual([1, 12]);
  });

  it("annual commitment can be billed monthly, quarterly, half-yearly or yearly; Flexible only monthly", () => {
    expect(frequenciesFor("annual")).toEqual(["yearly", "half_yearly", "quarterly", "monthly"]);
    expect(frequenciesFor("three_year")).toEqual(["yearly", "half_yearly", "quarterly", "monthly"]);
    expect(frequenciesFor("flex")).toEqual(["monthly"]);
  });
});

describe("licence cost follows the commitment's catalogue tier", () => {
  it("Flexible → the flex tier (₹318); annual → the annual tier (₹264) whatever the frequency", () => {
    expect(catalogCostPerSeatMonth(ITEM, 1)).toBe(318);
    expect(catalogCostPerSeatMonth(ITEM, 12)).toBe(264);
    expect(catalogCostPerSeatMonth(ITEM, 36)).toBe(264);
  });

  it("an annual commitment never falls back to the higher flex cost; flex falls back to annual", () => {
    const flexOnly = { id: "x", wholesale: 0, prices: { monthly: { msrp: 360, wholesale: 318 } } } as unknown as Item;
    expect(catalogCostPerSeatMonth(flexOnly, 12)).toBeNull();
    const annualOnly = { id: "y", wholesale: 264, prices: { annual: { msrp: 300, wholesale: 264 } } } as unknown as Item;
    expect(catalogCostPerSeatMonth(annualOnly, 1)).toBe(264);
    expect(catalogCostPerSeatMonth(undefined, 12)).toBeNull();
  });

  it("Venus: after switching to annual, the margin uses ₹264 and the false loss is gone", () => {
    const venus = { seats: 10, mrr: 3_000, item_id: "gws-std", vendor_cost_per_seat_month: 318, vendor_synced_at: null } as Subscription;
    const before = subscriptionCogs(venus, [ITEM]);
    expect(before.marginMonthly).toBe(-180);           // 3,000 − 10 × 318 — the false loss
    const after = subscriptionCogs({ ...venus, vendor_cost_per_seat_month: catalogCostPerSeatMonth(ITEM, 12) }, [ITEM]);
    expect(after.perSeatMonth).toBe(264);
    expect(after.marginMonthly).toBe(360);             // 3,000 − 2,640
    expect(after.marginBps).toBe(1200);
  });
});

describe("renewal after a commitment change — inclusive last day, counted from the start", () => {
  it("Flexible → Annual: the 12-month term that holds the current month (start + 12m − 1d)", () => {
    expect(commitmentRenewal({ startDate: "2026-06-15", renewalDate: "2026-11-14", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-30" }))
      .toBe("2027-06-14");
  });

  it("a flex sub older than a year lands on the annual term that covers today, not a past one", () => {
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-11-14", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-30" }))
      .toBe("2027-06-14");
  });

  it("month-end start clamps like termEndInclusive (31 Jan → 30 Jan next year)", () => {
    expect(commitmentRenewal({ startDate: "2026-01-31", renewalDate: "2026-11-30", termMonthsNow: 1, termMonthsNext: 12, today: "2026-11-10" }))
      .toBe("2027-01-30");
  });

  it("same commitment (only the frequency changes) keeps the renewal date", () => {
    expect(commitmentRenewal({ startDate: "2026-06-15", renewalDate: "2027-06-14", termMonthsNow: 12, termMonthsNext: 12, today: "2026-10-30" }))
      .toBe("2027-06-14");
  });

  it("Annual → Flexible after the annual term has ended keeps the term end; next term is a month", () => {
    expect(commitmentRenewal({ startDate: "2025-06-15", renewalDate: "2026-06-14", termMonthsNow: 12, termMonthsNext: 1, today: "2026-10-30" }))
      .toBe("2026-06-14");
  });

  it("no start date → the renewal is left as it is", () => {
    expect(commitmentRenewal({ startDate: null, renewalDate: "2026-11-14", termMonthsNow: 1, termMonthsNext: 12, today: "2026-10-30" }))
      .toBe("2026-11-14");
  });
});

describe("the rule: an annual commitment is not reduced mid-term", () => {
  const base = {
    role: "owner", termMonthsNow: 12, cycleNow: "monthly" as const,
    startDate: "2026-06-15", renewalDate: "2027-06-14", today: "2026-10-30",
  };

  it("Annual → Flexible inside the running term is refused, with the date it can change", () => {
    const v = commitmentVerdict({ ...base, termMonthsNext: 1, cycleNext: "monthly" });
    expect(v.changed).toBe(true);
    expect(v.reduced).toBe(true);
    expect(v.block).toMatch(/cannot be reduced mid-term/);
    expect(v.block).toMatch(/2027-06-14|14 Jun 2027/);
  });

  it("Annual → Flexible after the term ended is allowed (owner/manager)", () => {
    const v = commitmentVerdict({ ...base, renewalDate: "2026-06-14", startDate: "2025-06-15", termMonthsNext: 1, cycleNext: "monthly" });
    expect(v.block).toBeNull();
    expect(v.roleBlock).toBeNull();
    expect(commitmentVerdict({ ...base, role: "billing", renewalDate: "2026-06-14", startDate: "2025-06-15", termMonthsNext: 1, cycleNext: "monthly" }).roleBlock)
      .toMatch(/owner or manager/);
  });

  it("Flexible → Annual is allowed for the money group (billing user too)", () => {
    const v = commitmentVerdict({ ...base, role: "billing", termMonthsNow: 1, renewalDate: "2026-11-14", termMonthsNext: 12, cycleNext: "monthly" });
    expect(v).toMatchObject({ changed: true, reduced: false, block: null, roleBlock: null });
    expect(commitmentVerdict({ ...base, role: "sales", termMonthsNow: 1, renewalDate: "2026-11-14", termMonthsNext: 12, cycleNext: "monthly" }).roleBlock)
      .toMatch(/owner, manager, accountant or billing/);
  });

  it("frequency only: annual billed monthly → quarterly → half-yearly is a change, not a reduction", () => {
    for (const next of ["quarterly", "half_yearly", "yearly"] as const) {
      const v = commitmentVerdict({ ...base, termMonthsNext: 12, cycleNext: next });
      expect(v).toMatchObject({ changed: true, reduced: false, block: null });
    }
    expect(commitmentVerdict({ ...base, termMonthsNext: 12, cycleNext: "monthly" }).changed).toBe(false);
  });

  it("Flexible billed anything but monthly is refused", () => {
    const v = commitmentVerdict({ ...base, termMonthsNow: 1, renewalDate: "2026-11-14", termMonthsNext: 1, cycleNext: "quarterly" });
    expect(v.block).toMatch(/Flexible is billed monthly only/);
  });
});

describe("split parts follow the frequency; the renewal stays commitment-based", () => {
  /* Venus after the switch: annual, start 15 Jun 2026, renewal 14 Jun 2027, ₹3,000/month. */
  const venus = { term_months: 12, start_date: "2026-06-15", renewal_date: "2027-06-14", mrr: 3_000 };

  it.each([
    ["monthly", 12, 3_000],
    ["quarterly", 4, 9_000],
    ["half_yearly", 2, 18_000],
    ["yearly", 1, 36_000],
  ] as const)("annual billed %s → %i parts of ₹%i, year ends 14 Jun 2027", (cycle, parts, each) => {
    const renewal = commitmentRenewal({ startDate: venus.start_date, renewalDate: venus.renewal_date, termMonthsNow: 12, termMonthsNext: 12, today: "2026-10-30" });
    expect(renewal).toBe("2027-06-14");
    const periods = subscriptionSchedule({ ...venus, billing_cycle: cycle });
    expect(periods).toHaveLength(parts);
    expect(periods.every((p) => p.amount === each)).toBe(true);
    expect(periods[0].periodStart).toBe("2026-06-15");
    expect(periods[periods.length - 1].periodEnd).toBe("2027-06-15");   // exclusive = renewal + 1 day
  });
});
