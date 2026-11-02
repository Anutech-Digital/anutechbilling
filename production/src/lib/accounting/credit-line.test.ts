/**
 * R-2374 — credit line (OD / flexi) helpers: the repayment split check (the server repeats it),
 * which loans a bank line can go to, and which expense heads are finance cost.
 * Owner example (OD audit 2 Nov): Bajaj Finance flexi, ₹40,00,000 drawn, interest-only ACH ₹46,000,
 * a ₹1,66,000 debit = ₹1,20,000 principal + ₹46,000 interest.
 */
import { describe, it, expect } from "vitest";
import {
  repaymentSplitErrors, principalFromLine, headroom, loansForLine, isFinanceCost, INTEREST_ON_LOANS, type LenderLoan,
} from "./credit-line";
import { EXPENSE_CATEGORIES } from "./expense-categories";

const bajaj: LenderLoan = { id: "od", lender: "Bajaj Finance", kind: "credit_line", status: "active", outstanding: 4_000_000, creditLimit: 5_000_000 };
const tata: LenderLoan = { id: "tl", lender: "Tata Capital", kind: "term", status: "active", outstanding: 200_000, creditLimit: null };
const hdfcOd: LenderLoan = { id: "hd", lender: "HDFC Bank", kind: "credit_line", status: "active", outstanding: 0, creditLimit: null };
const closed: LenderLoan = { id: "cl", lender: "ICICI", kind: "term", status: "closed", outstanding: 0, creditLimit: null };

describe("R-2374 repayment split", () => {
  it("interest-only ACH ₹46,000: principal 0, interest 46,000 is fine", () => {
    expect(principalFromLine(46_000, 46_000, 0)).toBe(0);
    expect(repaymentSplitErrors({ line: 46_000, principal: 0, interest: 46_000, tds: 0, outstanding: 4_000_000 })).toEqual([]);
  });
  it("₹1,66,000 = ₹1,20,000 principal + ₹46,000 interest", () => {
    expect(principalFromLine(166_000, 46_000, 0)).toBe(120_000);
    expect(repaymentSplitErrors({ line: 166_000, principal: 120_000, interest: 46_000, tds: 0, outstanding: 4_000_000 })).toEqual([]);
  });
  it("TDS 194A kept back: ₹41,400 line = ₹46,000 interest − ₹4,600 TDS", () => {
    expect(principalFromLine(41_400, 46_000, 4_600)).toBe(0);
    expect(repaymentSplitErrors({ line: 41_400, principal: 0, interest: 46_000, tds: 4_600, outstanding: 1 })).toEqual([]);
  });
  it("₹1 paise rounding is allowed, ₹2 is not", () => {
    expect(repaymentSplitErrors({ line: 46_001, principal: 0, interest: 46_000, tds: 0, outstanding: 0 })).toEqual([]);
    expect(repaymentSplitErrors({ line: 46_002, principal: 0, interest: 46_000, tds: 0, outstanding: 0 }))
      .toEqual(["Principal + interest − TDS must equal the bank line."]);
  });
  it("refuses: principal over owed, TDS over interest, nothing entered, not whole rupees", () => {
    expect(repaymentSplitErrors({ line: 300_000, principal: 300_000, interest: 0, tds: 0, outstanding: 200_000 }))
      .toEqual(["Principal is more than what is owed (200000)."]);
    expect(repaymentSplitErrors({ line: 0, principal: 0, interest: 100, tds: 200, outstanding: 0 }))
      .toContain("TDS cannot be more than the interest.");
    expect(repaymentSplitErrors({ line: 0, principal: 0, interest: 0, tds: 0, outstanding: 0 }))
      .toContain("Enter the principal or the interest of this payment.");
    expect(repaymentSplitErrors({ line: 10, principal: -1, interest: 11, tds: 0, outstanding: 0 }))
      .toEqual(["Principal, interest and TDS must be whole rupees, 0 or more."]);
  });
});

describe("R-2374 which loan a line goes to", () => {
  const all = [tata, hdfcOd, bajaj, closed];
  it("money in → credit lines only (a drawdown), the one the narration names first", () => {
    expect(loansForLine(all, "in", "FT BAJAJ FINANCE FLEXI DISB").map((l) => l.id)).toEqual(["od", "hd"]);
    expect(loansForLine(all, "in", "NEFT CR HDFC BANK OD").map((l) => l.id)).toEqual(["hd", "od"]);
  });
  it("money out → loans with money owed (term or credit line), named first, closed / ₹0 left out", () => {
    expect(loansForLine(all, "out", "ACH DR TATA CAPITAL").map((l) => l.id)).toEqual(["tl", "od"]);
    expect(loansForLine(all, "out", "ACH DR SOMEONE").map((l) => l.id)).toEqual(["od", "tl"]);
  });
  it("headroom: limit − owed; null with no limit; negative when over", () => {
    expect(headroom(bajaj)).toBe(1_000_000);
    expect(headroom(hdfcOd)).toBeNull();
    expect(headroom({ creditLimit: 100, outstanding: 150 })).toBe(-50);
  });
});

describe("R-2374 finance cost heads", () => {
  it("'Interest on loans / OD' is an expense head and finance cost; so is the EMI 'Interest'", () => {
    expect(EXPENSE_CATEGORIES).toContain(INTEREST_ON_LOANS);
    expect(isFinanceCost(INTEREST_ON_LOANS)).toBe(true);
    expect(isFinanceCost("Interest")).toBe(true);
    expect(isFinanceCost("Bank Charges")).toBe(false);
    expect(isFinanceCost(null)).toBe(false);
  });
});
