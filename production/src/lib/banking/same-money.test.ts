/**
 * R-2192: ₹1 tolerance — the owner's audit examples (banking.md §4 "₹2,535 vs ₹2,535",
 * AKS Q-0224 ₹1 due).
 */
import { describe, it, expect } from "vitest";
import { sameMoney, roundOffGap, ROUND_OFF_AUTO } from "./same-money";

describe("R-2192 sameMoney", () => {
  it("₹2,534.73 on the bank line is the ₹2,535 invoice", () => {
    expect(sameMoney(253473 / 100, 2535)).toBe(true);
  });
  it("₹13,105 vs ₹13,106 — ₹1 apart is the same money, both ways", () => {
    expect(sameMoney(13105, 13106)).toBe(true);
    expect(sameMoney(13107, 13106)).toBe(true);
  });
  it("₹2 apart is not", () => {
    expect(sameMoney(13104, 13106)).toBe(false);
    expect(sameMoney(13108, 13106)).toBe(false);
  });
  it("₹1.01 apart is not (paise decide, not float noise)", () => {
    expect(sameMoney(13104.99, 13106)).toBe(false);
    expect(sameMoney(0.1 + 0.2, 0.3, 0)).toBe(true);
  });
  it("a custom tolerance", () => {
    expect(sameMoney(100, 150, 50)).toBe(true);
    expect(sameMoney(100, 151, 50)).toBe(false);
  });
  it("not a number → never the same", () => {
    expect(sameMoney(Number.NaN, 1)).toBe(false);
    expect(sameMoney(1, Number.POSITIVE_INFINITY)).toBe(false);
  });
  it("roundOffGap: only a non-zero gap within ₹1", () => {
    expect(roundOffGap(13105, 13106)).toBe(true);
    expect(roundOffGap(13106, 13106)).toBe(false);
    expect(roundOffGap(13104, 13106)).toBe(false);
    expect(ROUND_OFF_AUTO).toBe(1);
  });
});
