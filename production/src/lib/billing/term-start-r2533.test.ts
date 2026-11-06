import { describe, it, expect } from "vitest";
import { currentTermStart, subscriptionSchedule, billingTermStart, uncheckedTermStart } from "./subscription-schedule";
import { plannedInstalments } from "./instalments";

/**
 * R-2533 (6 Nov 2026, w-term-scan): Suresh Kumar & Co — sale started 19 Jun 2026, but its
 * renewal date was saved as 19 Dec 2026 (the next HALF) on a 12-month, half-yearly term.
 * The term start was counted back from the renewal date (20 Dec 2026 − 12 months =
 * 20 Dec 2025), start_date was ignored, and part #1 was invoiced on 20 Dec 2025 — six
 * months before the customer bought anything.
 *
 * Rule: the current term never starts before the subscription's own start_date.
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

  it("plannedInstalments lays no part before 19 Jun 2026", () => {
    const parts = plannedInstalments(suresh);
    expect(parts.length).toBe(2);
    for (const p of parts) {
      expect(p.termStart >= "2026-06-19").toBe(true);
      expect(p.periodStart >= "2026-06-19").toBe(true);
      expect(p.billOn >= "2026-06-19").toBe(true);
    }
    expect(parts[0].periodStart).toBe("2026-06-19");
    expect(parts[0].termStart).toBe("2026-06-19");
  });

  it("subscriptionSchedule for the Suresh shape opens on the start date", () => {
    expect(subscriptionSchedule(suresh)[0].periodStart).toBe("2026-06-19");
  });

  it("a renewed subscription still counts back from the renewal date (start_date is years ago)", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2023-04-01", renewal_date: "2027-03-31" })).toBe("2026-04-01");
  });

  it("first-term rows in both stored shapes are unchanged", () => {
    // inclusive last day
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: "2027-06-18" })).toBe("2026-06-19");
    // anniversary
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: "2027-06-19" })).toBe("2026-06-19");
  });

  it("no renewal date → start_date, as before", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2026-06-19", renewal_date: null })).toBe("2026-06-19");
  });

  it("month-end: start 29 Feb 2024, anniversary renewal 28 Feb 2025 → term starts 29 Feb 2024, not the 28th", () => {
    expect(currentTermStart({ term_months: 12, start_date: "2024-02-29", renewal_date: "2025-02-28" })).toBe("2024-02-29");
  });
});

describe("R-2533: the billing job keeps a term already filed under the old (counted-back) key", () => {
  it("uncheckedTermStart is the counted-back date the job used before R-2533", () => {
    expect(uncheckedTermStart(suresh)).toBe("2025-12-20");
  });

  it("rows filed under the old key keep that key — no second set of parts for the same term", () => {
    expect(billingTermStart("2026-06-19", ["2025-12-20"], "2025-12-20")).toBe("2025-12-20");
  });

  it("no rows under the old key → the corrected key", () => {
    expect(billingTermStart("2026-06-19", [], "2025-12-20")).toBe("2026-06-19");
    expect(billingTermStart("2026-06-19", ["2026-06-19", "2025-12-20"], "2025-12-20")).toBe("2026-06-19");
  });
});
