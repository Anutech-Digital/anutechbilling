/**
 * R-802 — Add seats on a RENEWED subscription: the term is the CURRENT one, from
 * renewal_date and term_months, never from the stored start_date.
 *
 * start_date is the day of the first sale; record_payment only rolls renewal_date forward on
 * a renewal. In the local DB 3 of 6 active subs looked like this: start 15 Sep 2023, renewal
 * 14 Sep 2026, term 12 months. Counting from start_date made that a 1,096-day "term": +1 seat
 * at ₹3,240/seat/yr with 106 days left charged ₹313 instead of ₹941, and the Effective date
 * could be backdated to 2023.
 */
import { describe, it, expect } from "vitest";
import { seatChargeWindow, seatTermStart, seatTermDays } from "./seat-charge-window";
import { resolveTermDays } from "./apply-seat-increase";
import { checkSeatEffectiveDate, seatEffectiveBounds } from "./seat-effective-date";
import { currentTermStart, subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";
import type { BillingCycle } from "@/lib/supabase/database.types";

const TODAY = "2026-06-01";
/** Sold 15 Sep 2023, renewed in 2024 and 2025; current term 15 Sep 2025 → 14 Sep 2026. */
const RENEWED_INCLUSIVE = {
  mrr: 270, seats: 1, billing_cycle: "yearly" as BillingCycle, term_months: 12,
  start_date: "2023-09-15", renewal_date: "2026-09-14",
};
const RENEWED_ANNIVERSARY = { ...RENEWED_INCLUSIVE, renewal_date: "2026-09-15" };

const rupees = (remainingDays: number, termDays: number) =>
  Math.round(paiseToRupees(prorate({ annualPerSeatPaise: rupeesToPaise(3240), seats: 1, remainingDays, termDays, taxRatePct: 0 }).subtotalPaise));

describe("renewed multi-year row — the current term, not start_date → renewal", () => {
  for (const [label, sub] of [["inclusive-end", RENEWED_INCLUSIVE], ["anniversary", RENEWED_ANNIVERSARY]] as const) {
    it(`${label}: term starts 15 Sep 2025, 365 days, +1 seat = ₹941 not ₹313`, () => {
      expect(currentTermStart(sub)).toBe("2025-09-15");
      expect(seatTermStart(sub)).toBe("2025-09-15");
      expect(seatTermDays(sub)).toBe(365);
      expect(resolveTermDays(sub)).toBe(365);
      const w = seatChargeWindow(sub, TODAY)!;
      expect(w).toEqual({ remainingDays: 106, termDays: 365, chargeTo: sub.renewal_date, instalmentPeriod: false });
      expect(rupees(w.remainingDays, w.termDays)).toBe(941);
      /* What the old start_date reading charged — a third of it. */
      expect(rupees(106, 1096)).toBe(313);
    });

    /* R-543 (10 Oct 2026, Pardeep: haan) widened this from the current term to the PREVIOUS
       term — still never 2023/2024 (two terms back). seat-previous-term.test.ts has the charge. */
    it(`${label}: Effective date can reach the previous term, never further`, () => {
      expect(seatEffectiveBounds(sub, TODAY)).toEqual({ min: "2024-09-15", max: TODAY });
      expect(checkSeatEffectiveDate("2025-09-15", sub, TODAY).ok).toBe(true);
      expect(checkSeatEffectiveDate("2025-09-14", sub, TODAY).ok).toBe(true);
      const r = checkSeatEffectiveDate("2024-09-14", sub, TODAY);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/before the previous term started/);
      expect(checkSeatEffectiveDate("2024-01-01", sub, TODAY).ok).toBe(false);
    });
  }

  it("a backdated charge covers only days in the current term", () => {
    const w = seatChargeWindow(RENEWED_INCLUSIVE, TODAY, "2025-09-15")!;
    expect([w.remainingDays, w.termDays]).toEqual([365, 365]);
    expect(rupees(w.remainingDays, w.termDays)).toBe(3240);
  });

  it("term_months null falls back to 12", () => {
    /* The column is NOT NULL with a default, but older imports reached the code without it. */
    const sub = { ...RENEWED_INCLUSIVE, term_months: null as unknown as number };
    expect(seatTermDays(sub)).toBe(365);
    expect(resolveTermDays(sub)).toBe(365);
    expect(seatEffectiveBounds(sub, TODAY)!.min).toBe("2024-09-15"); // R-543: previous term start
    expect(seatChargeWindow(sub, TODAY)!.termDays).toBe(365);
  });

  it("a renewed 24-month row is 730 days from its current term start", () => {
    const sub = { ...RENEWED_INCLUSIVE, term_months: 24, start_date: "2022-04-01", renewal_date: "2026-03-31" };
    expect(seatTermStart(sub)).toBe("2024-04-01");
    expect(seatTermDays(sub)).toBe(730);
    /* R-543: the previous 24-month term began 1 Apr 2022 — the sale itself. */
    expect(seatEffectiveBounds(sub, "2026-01-10")!.min).toBe("2022-04-01");
  });
});

describe("renewed quarterly row — still only to the current instalment end", () => {
  const Q = { ...RENEWED_INCLUSIVE, billing_cycle: "quarterly" as BillingCycle };

  it("schedule and seat window agree on the current term", () => {
    expect(subscriptionSchedule(Q)[0].periodStart).toBe("2025-09-15");
    /* Quarter 15 Mar → 14 Jun 2026: 14 days from 1 Jun, over the 365-day term. */
    expect(seatChargeWindow(Q, TODAY)).toEqual({ remainingDays: 14, termDays: 365, chargeTo: "2026-06-14", instalmentPeriod: true });
    expect(resolveTermDays(Q)).toBe(365);
  });
});

describe("rows R-801 already got right — numbers unchanged", () => {
  it("fresh 1-year inclusive row: 365 days, earliest = start_date", () => {
    const sub = { ...RENEWED_INCLUSIVE, start_date: "2026-04-01", renewal_date: "2027-03-31" };
    expect(seatTermDays(sub)).toBe(365);
    expect(seatChargeWindow(sub, "2026-09-25")).toEqual({ remainingDays: 188, termDays: 365, chargeTo: "2027-03-31", instalmentPeriod: false });
    expect(seatEffectiveBounds(sub, "2026-10-10")!.min).toBe("2026-04-01");
  });

  it("fresh anniversary row: 365 days, earliest = start_date", () => {
    const sub = { ...RENEWED_INCLUSIVE, start_date: "2026-04-01", renewal_date: "2027-04-01" };
    expect(resolveTermDays(sub)).toBe(365);
    expect(seatEffectiveBounds(sub, "2026-10-10")!.min).toBe("2026-04-01");
  });

  it("a leap-day term is still 366 days, as before", () => {
    const sub = { ...RENEWED_INCLUSIVE, start_date: "2027-06-01", renewal_date: "2028-05-31" };
    expect(seatTermDays(sub)).toBe(366);
  });

  it("no start_date: the 365 days ending on the inclusive renewal date", () => {
    const sub = { ...RENEWED_INCLUSIVE, start_date: null, renewal_date: "2027-04-01" };
    expect(seatTermDays(sub)).toBe(365);
    expect(seatEffectiveBounds(sub, "2026-10-10")!.min).toBe("2026-04-02");
  });

  it("a short first term can't be backdated before the sale itself", () => {
    /* Sold 10 Jan 2026, co-termed to 31 Dec 2026: the term is 1 Jan → 31 Dec (365 days,
       the schedule's rule), but there were no seats before 10 Jan. */
    const sub = { ...RENEWED_INCLUSIVE, start_date: "2026-01-10", renewal_date: "2026-12-31" };
    expect(seatTermDays(sub)).toBe(365);
    expect(seatEffectiveBounds(sub, "2026-06-01")!.min).toBe("2026-01-10");
    expect(checkSeatEffectiveDate("2026-01-09", sub, "2026-06-01").ok).toBe(false);
  });
});
