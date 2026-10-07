import { describe, it, expect } from "vitest";
import { trialDaysLeft } from "./days-left";
import { quoteTrialState } from "./start-from-quote";
import { bucketize } from "@/lib/queries/trials";
import type { Lead } from "@/lib/supabase/database.types";

// R-319: one trial (ends 21 Oct 23:59 IST) read as "14 days left" on the quote and "15d left"
// in Subscriptions → Trials in progress. Both screens must say the same number.
const ENDS = "2026-10-21T18:29:00Z"; // 21 Oct 2026, 23:59 IST
const MORNING = new Date("2026-10-07T02:20:00Z"); // 7 Oct, 07:50 IST

describe("trialDaysLeft (IST calendar days)", () => {
  it("counts IST calendar days, not rounded 24h blocks", () => {
    expect(trialDaysLeft(ENDS, MORNING)).toBe(14);
  });

  it("is 0 on the last day and negative after it", () => {
    expect(trialDaysLeft(ENDS, new Date("2026-10-21T04:00:00Z"))).toBe(0);
    expect(trialDaysLeft(ENDS, new Date("2026-10-22T04:00:00Z"))).toBe(-1);
  });

  it("uses the IST date of a late-evening UTC instant", () => {
    // 20 Oct 19:00Z = 21 Oct 00:30 IST → last day.
    expect(trialDaysLeft(ENDS, new Date("2026-10-20T19:00:00Z"))).toBe(0);
  });

  it("quote page and Subscriptions show the same number for the same trial", () => {
    const lead = {
      trial_started_at: "2026-10-07T02:00:00Z",
      trial_expires_at: ENDS,
      trial_converted_at: null,
      trial_expired_at: null,
    };
    const quote = quoteTrialState(lead, MORNING);
    const sub = bucketize(lead as unknown as Lead, MORNING);
    expect(quote).toEqual({ kind: "running", endDate: "2026-10-21", daysLeft: 14 });
    expect(sub.days_remaining).toBe(14);
  });

  it("Subscriptions bucket uses the same day count (expired = past last IST day)", () => {
    const lead = { trial_started_at: "2026-10-01T00:00:00Z", trial_expires_at: ENDS, trial_converted_at: null } as unknown as Lead;
    expect(bucketize(lead, new Date("2026-10-21T17:00:00Z")).bucket).toBe("expiring_soon");
    const past = bucketize(lead, new Date("2026-10-22T04:00:00Z"));
    expect(past.bucket).toBe("expired_unconverted");
    expect(past.days_past_expiry).toBe(1);
  });
});
