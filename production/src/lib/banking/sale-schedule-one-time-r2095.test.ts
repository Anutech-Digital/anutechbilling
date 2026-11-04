/**
 * R-2095 (30 Oct 2026, September reconcile): a new sale billed quarterly with a one-time line
 * (setup ₹5,000) spread the setup across the four quarters ("Due now" = (year + setup) ÷ 4). A
 * one-time line is billed once — in the first part; only the subscription lines are split.
 */
import { describe, it, expect } from "vitest";
import { saleSchedule, type SaleLine } from "./credit-pay-for";

const sub: SaleLine = { itemId: "w", name: "Workspace Starter", qty: 10, rate: 3240, cost: 0, cycle: "annual_yearly", perSeat: true } as SaleLine;
const setup: SaleLine = { itemId: "s", name: "Setup", qty: 1, rate: 5000, cost: 0, cycle: "one_time", perSeat: false } as SaleLine;

describe("R-2095 one-time lines on a sale billed in parts", () => {
  it("quarterly: first bill = a quarter of the subscription + the whole setup; later bills = subscription only", () => {
    const s = saleSchedule([sub, setup], 18, "quarterly", "2026-09-01");
    // 32,400 / 4 = 8,100 + 5,000 setup = 13,100 taxable → 15,458 incl GST
    expect(s.dueTaxable).toBe(8100 + 5000);
    expect(s.dueNow).toBe(Math.round(8100 * 1.18) + Math.round(5000 * 1.18));
    expect(s.later).toHaveLength(3);
    expect(s.later.every((b) => b.gross === Math.round(8100 * 1.18))).toBe(true);
  });
  it("no one-time line → unchanged", () => {
    const s = saleSchedule([sub], 18, "quarterly", "2026-09-01");
    expect(s.dueTaxable).toBe(8100);
  });
});
