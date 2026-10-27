// R-1952: still due = amount − tds_amount − advance_applied − paid_amount, never the full bill.
import { describe, it, expect } from "vitest";
import { expenseCashDue, expenseDueNote } from "./still-due";
import { rupee } from "@/lib/utils";

describe("R-1952 expenseCashDue", () => {
  it("owner's card example: ₹5,000 bill, ₹3,000 advance applied → ₹2,000", () => {
    expect(expenseCashDue({ amount: 5000, advance_applied: 3000 })).toBe(2000);
  });
  it("part-paid from the bank: ₹10,000 bill, ₹4,000 part → ₹6,000", () => {
    expect(expenseCashDue({ amount: 10000, paid_amount: 4000 })).toBe(6000);
  });
  it("TDS goes to the government: ₹10,000 bill, ₹1,000 TDS → ₹9,000 to the vendor", () => {
    expect(expenseCashDue({ amount: 10000, tds_amount: 1000 })).toBe(9000);
  });
  it("all four together, never below zero, nulls are zero", () => {
    expect(expenseCashDue({ amount: 59000, tds_amount: 5000, advance_applied: 10000, paid_amount: 20000 })).toBe(24000);
    expect(expenseCashDue({ amount: 4000, advance_applied: 4000 })).toBe(0);
    expect(expenseCashDue({ amount: 1000, advance_applied: 2000 })).toBe(0);
    expect(expenseCashDue({ amount: null, tds_amount: null, advance_applied: null, paid_amount: null })).toBe(0);
  });
});

describe("R-1952 expenseDueNote", () => {
  it("names what came off the bill", () => {
    expect(expenseDueNote({ amount: 5000, advance_applied: 3000 }, rupee)).toBe(`bill ${rupee(5000)} − advance ${rupee(3000)}`);
    expect(expenseDueNote({ amount: 10000, tds_amount: 1000, paid_amount: 4000 }, rupee))
      .toBe(`bill ${rupee(10000)} − TDS ${rupee(1000)} − already paid ${rupee(4000)}`);
  });
  it("empty when nothing came off", () => {
    expect(expenseDueNote({ amount: 5000 }, rupee)).toBe("");
  });
});
