import { describe, expect, it } from "vitest";

import { cashReceived } from "./cash-received";

describe("cashReceived (R-1565)", () => {
  it("amount minus the advance credit applied", () => {
    expect(cashReceived({ amount: 6_000, credit_applied: 4_000 })).toBe(2_000);
    expect(cashReceived({ amount: 10_000, credit_applied: 10_000 })).toBe(0);
  });
  it("no column / null / 0 → all of it is cash (the old reading)", () => {
    expect(cashReceived({ amount: 5_000 })).toBe(5_000);
    expect(cashReceived({ amount: 5_000, credit_applied: null })).toBe(5_000);
    expect(cashReceived({ amount: 5_000, credit_applied: 0 })).toBe(5_000);
  });
  it("a bad credit value never makes cash negative or larger than the amount", () => {
    expect(cashReceived({ amount: 1_000, credit_applied: 5_000 })).toBe(0);
    expect(cashReceived({ amount: 1_000, credit_applied: -50 })).toBe(1_000);
  });
});
