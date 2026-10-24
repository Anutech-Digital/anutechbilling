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
