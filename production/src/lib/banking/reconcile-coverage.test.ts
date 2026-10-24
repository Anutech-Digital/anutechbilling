import { describe, it, expect } from "vitest";
import { reconcileCoverage } from "./reconcile-coverage";

const l = (debit: number, credit: number, matched: string | null) => ({ debit, credit, matched_to_type: matched });

describe("reconcileCoverage — how much of the account's money the books account for", () => {
  it("the staging case: big unreconciled credits never show as a negative 'balance'", () => {
    // Old tile: opening + reconciled lines only = a big negative "Balance in app".
    const lines = [l(1_500_000, 0, "salary"), l(500_000, 0, "expense"), l(0, 2_600_000, null), l(0, 100_000, "payment")];
    const c = reconcileCoverage(lines);
    expect(c.reconciledAmount).toBe(2_100_000);
    expect(c.totalAmount).toBe(4_700_000);
    expect(c.leftAmount).toBe(2_600_000);
    expect(c.leftLines).toBe(1);
    expect(c.reconciledLines).toBe(3);
    expect(c.totalLines).toBe(4);
    expect(c.leftIn).toBe(2_600_000);
    expect(c.leftOut).toBe(0);
    expect(c.percent).toBe(44);
    for (const v of Object.values(c)) if (typeof v === "number") expect(v).toBeGreaterThanOrEqual(0);
  });

  it("all reconciled = 100% and nothing left", () => {
    const c = reconcileCoverage([l(100, 0, "expense"), l(0, 200, "payment")]);
    expect(c).toMatchObject({ percent: 100, leftAmount: 0, leftLines: 0, done: true });
  });

  it("99.6% rounds DOWN — 100% only when nothing is left", () => {
    const c = reconcileCoverage([l(996, 0, "expense"), l(4, 0, null)]);
    expect(c.percent).toBe(99);
    expect(c.done).toBe(false);
  });

  it("no lines yet", () => {
    expect(reconcileCoverage([])).toMatchObject({ totalLines: 0, percent: 0, done: false });
  });

  it("left in / left out split the gap by direction", () => {
    const c = reconcileCoverage([l(300, 0, null), l(0, 700, null), l(1000, 0, "expense")]);
    expect(c.leftIn).toBe(700);
    expect(c.leftOut).toBe(300);
    expect(c.leftAmount).toBe(1000);
    expect(c.percent).toBe(50);
  });

  it("paise sum without a float tail", () => {
    const c = reconcileCoverage([l(0.1, 0, "expense"), l(0.2, 0, "expense"), l(0.3, 0, null)]);
    expect(c.reconciledAmount).toBe(0.3);
    expect(c.leftAmount).toBe(0.3);
  });
});
