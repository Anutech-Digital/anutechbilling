/**
 * R-2340 — loan GIVEN with a monthly receipt (EMI), set up from a money-in bank line.
 * Owner example: ₹3,50,000 lent to Vinod Hem Raj at 12% a year, 24 receipts of ₹16,476 from
 * 5 Oct 2026. The numbers are the ones the SQL test (supabase/tests/r2340_loan_given_from_bank_line
 * .test.sql) proves the server books — the preview and the booked split must be the same rupee.
 */
import { describe, expect, it } from "vitest";
import {
  emiReceiptSchedule, loanGivenSetupErrors, loanGivenSetupPayload, loanPosition, loanSchedule,
  matchLoanGivenReceipts, monthInterest, nextEmiReceipt, splitRepayment,
  type LoanGivenSetupInput, type LoanTerms,
} from "./loans-given";

const vinod: LoanTerms = {
  principal: 350000, givenOn: "2026-09-05", interestRate: 12, plan: "emi",
  dueOn: "2026-10-05", instalments: 24, emi: 16476,
};

describe("R-2340 reducing-balance receipts (the server's rule)", () => {
  it("receipt 1 = ₹12,976 principal + ₹3,500 interest; receipt 2 = ₹13,106 + ₹3,370; the last clears", () => {
    const rows = emiReceiptSchedule(350000, 12, 16476, 24, "2026-10-05");
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({ seq: 1, dueOn: "2026-10-05", amount: 16476, principal: 12976, interest: 3500, balanceAfter: 337024 });
    expect(rows[1]).toMatchObject({ seq: 2, dueOn: "2026-11-05", amount: 16476, principal: 13106, interest: 3370 });
    expect(rows[23]).toMatchObject({ seq: 24, amount: 16467, principal: 16304, interest: 163, balanceAfter: 0 });
    expect(rows.reduce((s, r) => s + r.principal, 0)).toBe(350000);
  });

  it("rounds a half rupee up, like the server's round(numeric)", () => {
    expect(monthInterest(10050, 12)).toBe(101);   // 100.5
    expect(monthInterest(0, 12)).toBe(0);
    expect(monthInterest(5000, 0)).toBe(0);
  });

  it("next receipt follows the receipts on the books; the last one = what is left + interest", () => {
    expect(nextEmiReceipt(vinod, 0, 0)).toEqual({ seq: 1, amount: 16476, principal: 12976, interest: 3500, isLast: false });
    expect(nextEmiReceipt(vinod, 12976, 1)).toEqual({ seq: 2, amount: 16476, principal: 13106, interest: 3370, isLast: false });
    const small: LoanTerms = { principal: 20000, givenOn: "2026-09-10", interestRate: 12, plan: "emi", dueOn: "2026-10-10", instalments: 2, emi: 10150 };
    expect(nextEmiReceipt(small, 9950, 1)).toEqual({ seq: 2, amount: 10151, principal: 10050, interest: 101, isLast: true });
    expect(nextEmiReceipt(small, 20000, 2)).toBeNull();
  });

  it("splitRepayment on an EMI loan: interest on what is left, then principal; more than owed is too much", () => {
    const parts = [{ repaidOn: "2026-10-05", amount: 16476, principalPart: 12976, interestPart: 3500 }];
    expect(splitRepayment(vinod, parts, "2026-11-05", 16476)).toMatchObject({ interestPart: 3370, principalPart: 13106, tooMuch: false });
    expect(splitRepayment(vinod, parts, "2026-11-05", 337024 + 3371).tooMuch).toBe(true);
    expect(splitRepayment(vinod, parts, "2026-11-05", 337024 + 3370)).toMatchObject({ closes: true, maxAmount: 340394 });
  });

  it("an EMI loan's position: nothing accrues between receipts; outstanding = principal left", () => {
    const p = loanPosition(vinod, [{ repaidOn: "2026-10-05", amount: 16476, principalPart: 12976, interestPart: 3500 }], "2026-12-31");
    expect(p).toEqual({ principalRepaid: 12976, interestReceived: 3500, principalLeft: 337024, interestDue: 0, outstanding: 337024 });
  });

  it("the Loans given schedule shows each receipt with its amount", () => {
    const rows = loanSchedule(vinod, 12976, "2026-10-20");
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({ n: 1, principal: 12976, amount: 16476, state: "paid" });
    expect(rows[1]).toMatchObject({ n: 2, dueOn: "2026-11-05", amount: 16476, state: "due" });
  });
});

describe("R-2340 matching a money-in line to a loan given", () => {
  const loans = [
    { id: "old", borrowerName: "Suresh", status: "open", principalRepaid: 0, receipts: 0,
      terms: { principal: 50000, givenOn: "2026-09-15", interestRate: 10, plan: "one_shot", dueOn: null, instalments: null } as LoanTerms },
    { id: "vinod", borrowerName: "Vinod Hem Raj", status: "open", principalRepaid: 12976, receipts: 1, terms: vinod },
    { id: "done", borrowerName: "Closed", status: "closed", principalRepaid: 0, receipts: 0, terms: vinod },
  ];

  it("the next receipt of the same amount is suggested first, as receipt 2", () => {
    const m = matchLoanGivenReceipts(loans, 16476);
    expect(m[0]).toEqual({ loanId: "vinod", borrowerName: "Vinod Hem Raj", seq: 2, expected: 16476, confidence: "exact" });
    expect(m.map((x) => x.loanId)).toEqual(["vinod", "old"]);   // closed loans are never offered
  });

  it("₹1 off still matches; a different amount is only a low match", () => {
    expect(matchLoanGivenReceipts(loans, 16477)[0].confidence).toBe("exact");
    expect(matchLoanGivenReceipts(loans, 20000).every((x) => x.confidence === "low")).toBe(true);
  });
});

describe("R-2340 Set up loan given form", () => {
  const ok: LoanGivenSetupInput = {
    borrower: "Vinod Hem Raj", principal: 350000, annualRatePct: 12, emi: 16476, months: 24,
    firstDueOn: "2026-10-05", disbursalTxnId: null,
  };

  it("asks only for what is missing; an EMI below the month's interest is refused", () => {
    expect(loanGivenSetupErrors(ok)).toEqual([]);
    expect(loanGivenSetupErrors({ ...ok, borrower: " " })).toContain("Enter the borrower's name");
    expect(loanGivenSetupErrors({ ...ok, emi: 3000 })[0]).toMatch(/does not cover the first month's interest \(₹3500\)/);
  });

  it("the payload the server takes — receipt 1 = this line; lent before these books by default", () => {
    expect(loanGivenSetupPayload(ok, "line-1")).toEqual({
      borrower: "Vinod Hem Raj", borrower_type: "person", principal: 350000, interest_rate: 12, emi: 16476,
      instalments: 24, first_due_on: "2026-10-05", disbursal_txn_id: null, reconcile_txn_id: "line-1",
    });
  });
});
