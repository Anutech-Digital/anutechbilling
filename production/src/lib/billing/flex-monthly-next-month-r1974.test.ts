/**
 * R-1974 (26 Oct 2026) — how the NEXT month of a monthly (flex) online order is invoiced.
 *
 * The owner's order Q-1111-27-0009 (localhost, 26 Oct 2026): Standard × 2 monthly, ₹2,600
 * ex-GST, record_payment made the subscription billing_cycle 'monthly', term_months 1,
 * start 2026-10-26, renewal 2026-11-26, mrr 2,600. Month 1's invoice is its first instalment
 * (INV-1111-27-0006, paid). Month 2 is the two crons' job, with no quote:
 *   - renewals cron (R-808): no renewal quote for a split-billed sub; on 26 Nov it rolls
 *     renewal_date one term on;
 *   - billing cron: lays the new term's one period and raises it (PENDING — the original
 *     payment was already absorbed by month 1; proven in
 *     supabase/tests/r1974_flex_monthly_next_month.test.sql).
 * This pins the pure decisions both crons take, with the owner's real figures.
 */
import { describe, it, expect } from "vitest";
import { plannedInstalments, isSplitBilled } from "./instalments";
import { splitBilledRenewalStep, renewalQuoteBlockedReason } from "@/lib/renewals/split-billed-renewal";

const FLEX = {
  mrr: 2600,
  billing_cycle: "monthly" as const,
  term_months: 1,
  start_date: "2026-10-26",
  renewal_date: "2026-11-26",
};

describe("R-1974: a monthly (flex) subscription's next month", () => {
  it("month 1 is one instalment of the whole month — the invoice the payment raised", () => {
    expect(isSplitBilled(FLEX.billing_cycle)).toBe(true);
    const p = plannedInstalments(FLEX);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ periodIndex: 1, billOn: "2026-10-26", periodStart: "2026-10-26", taxableAmount: 2600 });
  });

  it("no renewal quote is made (it would bill the month twice)", () => {
    expect(renewalQuoteBlockedReason(FLEX.billing_cycle)).toMatch(/renews on its own/);
  });

  it("before 26 Nov the renewals cron waits; on 26 Nov it rolls renewal_date to 26 Dec", () => {
    expect(splitBilledRenewalStep({ ...FLEX, renewal_quote_id: null }, "2026-11-25")).toMatchObject({ kind: "wait" });
    expect(splitBilledRenewalStep({ ...FLEX, renewal_quote_id: null }, "2026-11-26"))
      .toEqual({ kind: "roll", nextTermStart: "2026-11-26", newRenewalDate: "2026-12-26" });
  });

  it("after the roll the billing cron lays month 2 — ₹2,600 ex-GST, billed 26 Nov, its own term key", () => {
    const p = plannedInstalments({ ...FLEX, renewal_date: "2026-12-26" });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ termStart: "2026-11-26", periodIndex: 1, billOn: "2026-11-26", periodStart: "2026-11-26", taxableAmount: 2600 });
  });
});
