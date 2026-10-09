import { describe, it, expect } from "vitest";
import { subscriptionSchedule, nextTermSchedule, upcomingForSubscription, followingTermStart, isAnniversaryRenewal, billingTermStart } from "./subscription-schedule";
import { scheduleTotal } from "./schedule";
import type { Subscription } from "@/lib/supabase/database.types";

/**
 * `renewal_date` is the LAST COVERED DAY — 31 Mar 2027, not 1 Apr 2027.
 *
 * Changed 11 Sep 2026 (Abhishek). The fixture moved by one day and every expectation
 * below stayed exactly where it was, which is the point: the term still runs
 * 1 Apr 2026 → 31 Mar 2027 and term two still opens on 1 Apr 2027. Only the number in
 * the column changed; the days the customer is billed for did not.
 */
const sub = (over: Partial<Subscription> = {}) => ({
  mrr: 10_000,
  billing_cycle: "yearly" as const,
  term_months: 12,
  start_date: "2023-04-01",
  renewal_date: "2027-03-31",
  ...over,
}) as Subscription;

describe("the schedule is anchored on renewal_date, not start_date", () => {
  it("lays the CURRENT term backwards from the renewal", () => {
    /* A subscription renewed three times has a start_date from years ago. Laying the
       schedule from there would bill a term that ended in 2023. */
    const s = subscriptionSchedule(sub());
    expect(s[0].periodStart).toBe("2026-04-01");
    expect(s[0].periodEnd).toBe("2027-04-01");
  });

  it("falls back to start_date only when there is no renewal date", () => {
    const s = subscriptionSchedule(sub({ renewal_date: null }));
    expect(s[0].periodStart).toBe("2023-04-01");
  });

  it("returns nothing rather than guessing when there is neither date", () => {
    expect(subscriptionSchedule(sub({ renewal_date: null, start_date: null }))).toEqual([]);
  });
});

describe("the term total comes from mrr, so it cannot disagree with the dashboard", () => {
  it("annual term = mrr × 12", () => {
    expect(scheduleTotal(subscriptionSchedule(sub()))).toBe(120_000);
  });

  it("MULTI-YEAR term = mrr × term_months, not mrr × 12 × years", () => {
    /* Any multi-year discount is already inside the agreed mrr. */
    const s = subscriptionSchedule(sub({ term_months: 36, renewal_date: "2029-03-31" }));
    expect(scheduleTotal(s)).toBe(360_000);
    expect(s[0].periodStart).toBe("2026-04-01");
  });

  it("splits across the cycle and still sums exactly", () => {
    for (const cycle of ["monthly", "quarterly", "half_yearly", "yearly"] as const) {
      const s = subscriptionSchedule(sub({ billing_cycle: cycle, mrr: 8_333 }));
      expect(scheduleTotal(s), cycle).toBe(8_333 * 12);
    }
  });

  it("a zero-mrr subscription has no schedule rather than a row of ₹0", () => {
    expect(subscriptionSchedule(sub({ mrr: 0 }))).toEqual([]);
  });

  it("treats missing cycle/term as annual — the default the column carries", () => {
    const s = subscriptionSchedule(sub({ billing_cycle: undefined as never, term_months: undefined as never }));
    expect(s).toHaveLength(1);
    expect(scheduleTotal(s)).toBe(120_000);
  });
});

describe("nextTermSchedule", () => {
  it("starts on the renewal date", () => {
    const s = nextTermSchedule(sub());
    expect(s[0].periodStart).toBe("2027-04-01");
    expect(s[0].periodEnd).toBe("2028-04-01");
  });

  it("is empty without a renewal date — there is no next term to price", () => {
    expect(nextTermSchedule(sub({ renewal_date: null }))).toEqual([]);
  });
});

describe("upcomingForSubscription — the T-30 window", () => {
  it("sees the RENEWAL instalment thirty days out", () => {
    /* The interesting window is the one straddling a renewal. The renewal
       instalment lives in the NEXT term and would be invisible if only the current
       term were scanned — which is the whole reason both are considered. */
    const up = upcomingForSubscription(sub(), "2027-03-05", 30);
    expect(up.map((p) => p.billOn)).toEqual(["2027-04-01"]);
  });

  it("is quiet mid-term on an annual plan", () => {
    expect(upcomingForSubscription(sub(), "2026-09-01", 30)).toEqual([]);
  });

  it("sees the next quarterly instalment mid-term", () => {
    const up = upcomingForSubscription(sub({ billing_cycle: "quarterly" }), "2026-09-15", 30);
    expect(up.map((p) => p.billOn)).toEqual(["2026-10-01"]);
  });

  it("never returns a past date", () => {
    const up = upcomingForSubscription(sub({ billing_cycle: "monthly" }), "2026-11-20", 60);
    expect(up.every((p) => p.billOn >= "2026-11-20")).toBe(true);
  });

  it("does not duplicate the boundary instalment across the two terms", () => {
    const up = upcomingForSubscription(sub(), "2027-03-05", 60);
    expect(new Set(up.map((p) => p.billOn)).size).toBe(up.length);
  });
});

/* ── R-451 (9 Oct 2026): rows record_payment wrote with the ANNIVERSARY date ─────────── */

describe("R-451: a paid-quote subscription (renewal = start + 1 year) is not shifted a day", () => {
  /* Abhishek, Scenario 7: Sharma Traders, start 8 Oct 2026, renewal 8 Oct 2027. The panel
     said "THIS TERM 9 Oct 2026 … covers 9 Oct 2026 – 8 Oct 2027", "NEXT TERM 9 Oct 2027". */
  const sharma = sub({ start_date: "2026-10-08", renewal_date: "2027-10-08", mrr: 2_700 });

  it("this term starts on the start date", () => {
    const s = subscriptionSchedule(sharma);
    expect(s[0].billOn).toBe("2026-10-08");
    expect(s[0].periodStart).toBe("2026-10-08");
    expect(s[0].periodEnd).toBe("2027-10-08");   // exclusive end → covers to 7 Oct 2027
  });

  it("next term starts on the renewal date", () => {
    expect(nextTermSchedule(sharma)[0].billOn).toBe("2027-10-08");
  });

  it("a monthly paid-quote subscription bills on the same day each month", () => {
    const m = sub({ start_date: "2026-10-08", renewal_date: "2026-11-08", term_months: 1, billing_cycle: "monthly", mrr: 810 });
    expect(subscriptionSchedule(m)[0].billOn).toBe("2026-10-08");
    expect(nextTermSchedule(m)[0].billOn).toBe("2026-11-08");
  });

  it("an inclusive row (start + 1 year − 1 day) is read exactly as before", () => {
    const gupta = sub({ start_date: "2025-10-20", renewal_date: "2026-10-19" });
    expect(isAnniversaryRenewal(gupta)).toBe(false);
    expect(followingTermStart(gupta)).toBe("2026-10-20");
    expect(subscriptionSchedule(gupta)[0].billOn).toBe("2025-10-20");
  });

  it("an anniversary row renewed twice is still read as anniversary", () => {
    const twice = sub({ start_date: "2024-10-08", renewal_date: "2026-10-08" });
    expect(isAnniversaryRenewal(twice)).toBe(true);
    expect(subscriptionSchedule(twice)[0].billOn).toBe("2025-10-08");
  });

  it("with no start date the stored rule (inclusive) is used", () => {
    expect(followingTermStart(sub({ start_date: null, renewal_date: "2027-10-08" }))).toBe("2027-10-09");
  });
});

describe("R-451: the billing cron keeps an already-filed term's key", () => {
  it("uses the corrected start when nothing is filed yet", () => {
    expect(billingTermStart("2026-10-08", [])).toBe("2026-10-08");
  });
  it("keeps the old one-day-later key when this term was filed under it — no second set", () => {
    expect(billingTermStart("2026-10-08", ["2026-10-09"])).toBe("2026-10-09");
  });
  it("prefers the corrected key when it exists", () => {
    expect(billingTermStart("2026-10-08", ["2026-10-08", "2026-10-09"])).toBe("2026-10-08");
  });
});
