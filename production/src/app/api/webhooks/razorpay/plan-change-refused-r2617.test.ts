/**
 * R-2617 — record_payment's "plan change refused — a seat cut … is scheduled" (trigger
 * subscriptions_r2617_plan_change_vs_seat_cut) is a plan-change refusal like R-2227/R-2589: the
 * Razorpay webhook answers 200 and tells the owner (settleRefusedPlanChange), never a retry loop.
 */
import { describe, expect, it } from "vitest";
import { PLAN_CHANGE_REFUSED_RE } from "./late-payment.server";

describe("R-2617 PLAN_CHANGE_REFUSED_RE", () => {
  it.each([
    "R-2617: plan change refused — a seat cut 10 → 7 is scheduled for the end of this term (01 Apr 2027). Remove the scheduled seat cut in Manage seats first, then change the plan.",
    "R-2589: plan/seats changed since this quote Q-1 was made",
    "R-2227: plan change quote Q-1 is no longer linked to its subscription",
  ])("matches %s", (msg) => {
    expect(PLAN_CHANGE_REFUSED_RE.test(msg)).toBe(true);
  });

  it("other R-2617-like errors do not", () => {
    expect(PLAN_CHANGE_REFUSED_RE.test("R-2617x: plan change refused")).toBe(false);
    expect(PLAN_CHANGE_REFUSED_RE.test("R-2073: plan dropped from the catalogue")).toBe(false);
  });
});
