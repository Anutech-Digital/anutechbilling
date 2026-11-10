import { describe, it, expect } from "vitest";
import { currentTermStart, subscriptionSchedule, uncheckedTermStart, previousTermStart } from "./subscription-schedule";
import { plannedInstalments } from "./instalments";
import { seatTermDays, seatTermStart } from "@/lib/subscriptions/seat-charge-window";

/**
 * R-2533 (6 Nov 2026, w-term-scan): Suresh Kumar & Co — sale started 19 Jun 2026, but its
 * renewal date was saved as 19 Dec 2026 (the next HALF) on a 12-month, half-yearly term.
 * The term start was counted back from the renewal date (20 Dec 2026 − 12 months =
 * 20 Dec 2025), start_date was ignored, and part #1 was invoiced on 20 Dec 2025 — six
 * months before the customer bought anything.
 *
 * Rules: the current term never starts before start_date; a split-billed row whose renewal date
 * is less than one term after its start gets NO parts (the database refuses that shape now —
 * an older row waits for its renewal date to be corrected), never a part before the sale.
 */
const suresh = {
  mrr: 13_125,                 // ₹78,750 a half → ₹1,57,500 a year
  billing_cycle: "half_yearly" as const,
  term_months: 12,
  start_date: "2026-06-19",
  renewal_date: "2026-12-19",
};

describe("R-2533: the term never starts before start_date", () => {
  it("currentTermStart for the Suresh shape is the start date, not 20 Dec 2025", () => {
    expect(currentTermStart(suresh)).toBe("2026-06-19");
  });

  it("plannedInstalments lays no part before 19 Jun 2026 — none at all for the short term", () => {
    const parts = plannedInstalments(suresh);
    expect(parts.filter((p) => p.termStart < "2026-06-19" || p.periodStart < "2026-06-19" || p.billOn < "2026-06-19")).toEqual([]);
    expect(parts).toEqual([]);
  });

  it("subscriptionSchedule for the Suresh shape is empty, never Dec 2025", () => {
    expect(subscriptionSchedule(suresh)).toEqual([]);
  });

  it("once the renewal date covers the whole term (18 Jun 2027) the two halves start 19 Jun and 19 Dec 2026", () => {
    const parts = plannedInstalments({ ...suresh, renewal_date: "2027-06-18" });
    expect(parts.map((p) => [p.termStart, p.periodStart, p.billOn])).toEqual([
      ["2026-06-19", "2026-06-19", "2026-06-19"],
      ["2026-06-19", "2026-12-19", "2026-12-19"],
    ]);
  });

  it("after the approved Suresh repair (renewal 19 Jun 2027, anniversary) the job lays exactly the re-keyed rows — nothing new", () => {
    /* repair.sql: #1 term 2026-06-19, 19 Jun → 19 Dec 2026, bill_on 19 Jun (keeps INV-0001);
       #2 term 2026-06-19, 19 Dec 2026 → 19 Jun 2027, bill_on 19 Dec 2026. Same
       (term_start, period_index) → syncSubscriptionInstalments inserts nothing. */
    const repaired = { ...suresh, renewal_date: "2027-06-19" };
    expect(currentTermStart(repaired)).toBe("2026-06-19");
    expect(plannedInstalments(repaired).map((p) => [p.periodIndex, p.termStart, p.periodStart, p.periodEnd, p.billOn])).toEqual([
      [1, "2026-06-19", "2026-06-19", "2026-12-19", "2026-06-19"],
      [2, "2026-06-19", "2026-12-19", "2027-06-19", "2026-12-19"],
    ]);
  });

  it("a renewed subscription still counts back from the renewal date (start_date is years ago)", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2023-04-01", renewal_date: "2027-03-31" })).toBe("2026-04-01");
    expect(plannedInstalments({ ...suresh, start_date: "2023-06-19", renewal_date: "2026-12-19" })[0].periodStart).toBe("2025-12-20");
  });

  it("first-term rows in both stored shapes are unchanged", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: "2027-06-18" })).toBe("2026-06-19");
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: "2027-06-19" })).toBe("2026-06-19");
  });

  it("no renewal date → start_date, as before", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: null })).toBe("2026-06-19");
  });

  it("month-end: start 29 Feb 2024, anniversary renewal 28 Feb 2025 → term starts 29 Feb 2024, not the 28th", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2024-02-29", renewal_date: "2025-02-28" })).toBe("2024-02-29");
  });
});

describe("R-2533: a co-termed YEARLY sale keeps what it had", () => {
  /* Sold 10 Jan 2026, co-termed to 31 Dec 2026 — invoiced from its quote, priced per year. */
  const coTermed = { mrr: 270, billing_cycle: "yearly" as const, term_months: 12, start_date: "2026-01-10", renewal_date: "2026-12-31" };

  it("its schedule is the counted-back year it always showed", () => {
    expect(subscriptionSchedule(coTermed)[0].periodStart).toBe("2026-01-01");
  });

  it("seat pro-rata is still per whole year (365 days), the previous term one year before that", () => {
    expect(uncheckedTermStart(coTermed)).toBe("2026-01-01");
    expect(seatTermStart(coTermed)).toBe("2026-01-01");
    expect(seatTermDays(coTermed)).toBe(365);
    expect(previousTermStart(coTermed)).toBe("2025-01-01");
  });
});
