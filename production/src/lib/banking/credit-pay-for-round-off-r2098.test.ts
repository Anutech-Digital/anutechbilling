/* R-2098 follow-up (29 Oct, coordinator for Pardeep): the ≤ ₹50 round-off only when, after it,
   EVERY ticked item is settled in full. An item left part-paid → no round-off; the short amount
   stays due on it, and the bar never says "every item is settled in full". Same rule as
   reconcile_bank_credit_split (migration 20261029135130). */
import { describe, expect, it } from "vitest";

import { splitBlocked, splitPartPaid, splitRest, splitStateText, splitSummary } from "./credit-pay-for-multi";

describe("splitPartPaid", () => {
  it("true when any item (or the new sale) gets less than its due", () => {
    expect(splitPartPaid([{ amount: 590, due: 590 }, { amount: 1180, due: 1180 }])).toBe(false);
    expect(splitPartPaid([{ amount: 590, due: 590 }, { amount: 450, due: 1180 }])).toBe(true);
    expect(splitPartPaid([])).toBe(false);
  });
});

describe("round-off only when every item is settled in full", () => {
  it("A full + B part, ₹40 short (localhost: ₹3,640 on ₹5,310, ₹3,600 in) → refused, no round-off", () => {
    const s = splitSummary(1000, [590, 450], { partPaid: true });
    expect(s.state).toEqual({ kind: "partShort", short: 40 });
    expect(splitRest(s.state, "round_off")).toBeNull();
    expect(splitBlocked(s.state)).toBe(true);
    const text = splitStateText(s.state, null);
    expect(text).not.toContain("settled in full");
    expect(text).toContain("paid in part");
    expect(text).toContain("lower its amount by ₹40");
  });

  it("A full + B part, ₹10 extra → advance only (no round-off choice)", () => {
    const s = splitSummary(1000, [590, 400], { partPaid: true });
    expect(s.state).toEqual({ kind: "left", left: 10, canRoundOff: false });
    expect(splitRest(s.state, "round_off")).toBe("advance");
  });

  it("A full + B part, exact → fine, B stays part-due", () => {
    const s = splitSummary(1000, [590, 410], { partPaid: true });
    expect(s.state).toEqual({ kind: "exact" });
    expect(splitBlocked(s.state)).toBe(false);
  });

  it("every item in full, ₹20 short → round-off allowed and the bar may say settled in full", () => {
    const s = splitSummary(1750, [590, 1180], { partPaid: false });
    expect(s.state).toEqual({ kind: "short", short: 20 });
    expect(splitRest(s.state, "advance")).toBe("round_off");
    expect(splitBlocked(s.state)).toBe(false);
    expect(splitStateText(s.state, "round_off")).toContain("every item is settled in full");
  });

  it("beyond ₹50 over stays 'over' either way", () => {
    expect(splitSummary(1000, [1100], { partPaid: true }).state.kind).toBe("over");
  });
});
