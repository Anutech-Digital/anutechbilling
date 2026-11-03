import { describe, it, expect } from "vitest";
import { openOweHoldTotal, owedTotal, settleActions, OWE_HOLD_KINDS, OWE_HOLD_KIND_LABEL } from "./owe-hold";

describe("owe-hold helpers (R-2386)", () => {
  it("only open entries count", () => {
    expect(openOweHoldTotal([
      { amount: 5_00_000, status: "open" },
      { amount: 1_00_000, status: "settled" },
      { amount: 25_000, status: "open" },
    ])).toBe(5_25_000);
  });

  it("owedTotal adds cards, owe/hold and (later) loans in one place", () => {
    expect(owedTotal({ cardDues: 50_000, oweHoldOpen: 5_00_000 })).toBe(5_50_000);
    expect(owedTotal({ cardDues: 0, oweHoldOpen: 0, loansOutstanding: 2_00_000 })).toBe(2_00_000);
  });

  it("two kinds only — loans are a separate card (R-2388)", () => {
    expect(OWE_HOLD_KINDS).toEqual(["advance_received", "held_for_other"]);
    expect(OWE_HOLD_KIND_LABEL.advance_received).toBe("Advance received for a sale");
  });

  it("Convert into sale is offered only for an advance, and first", () => {
    expect(settleActions("advance_received").map((a) => a.how)).toEqual(["converted_to_sale", "refunded"]);
    expect(settleActions("held_for_other").map((a) => a.how)).toEqual(["handed_over"]);
  });
});
