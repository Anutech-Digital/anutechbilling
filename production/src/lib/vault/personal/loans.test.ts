import { describe, expect, it } from "vitest";

import {
  addMonthsISO,
  buildSchedule,
  computeEmi,
  financialYear,
  homeLoanItr,
  loanTotals,
  nextDue,
  splitEmi,
  summariseLoan,
  type LoanLike,
  type LoanPaymentLike,
} from "./loans";

// Pardeep's card example: home loan ₹20 lakh, 8.5%, 240 months.
const home: LoanLike = {
  id: "home", direction: "taken", loan_kind: "home", party: "SBI Home Loan", principal: 2000000,
  start_date: "2026-04-01", annual_rate: 8.5, repay_type: "emi", tenure_months: 240, emi_amount: 17356,
  first_due_on: null, status: "open",
};
const bro: LoanLike = {
  id: "bro", direction: "given", loan_kind: "person", party: "Brother", principal: 100000,
  start_date: "2026-04-01", annual_rate: null, repay_type: "no_interest", tenure_months: null, emi_amount: null,
  first_due_on: null, status: "open",
};

describe("R-2388 EMI maths (reducing balance)", () => {
  it("₹20 L at 8.5% for 240 months → EMI ₹17,356", () => {
    expect(computeEmi(2000000, 8.5, 240)).toBe(17356);
  });

  it("zero rate spreads the principal; missing tenure gives 0", () => {
    expect(computeEmi(100000, 0, 12)).toBe(8334);
    expect(computeEmi(100000, 10, null)).toBe(0);
  });

  it("first EMI split = interest on the outstanding, rest principal (same as the SQL RPC)", () => {
    expect(splitEmi(2000000, 8.5, 17356)).toEqual({ interest: 14167, principal: 3189 });
    expect(splitEmi(1996811, 8.5, 17356)).toEqual({ interest: 14144, principal: 3212 });
    // the last EMI never takes more principal than is left
    expect(splitEmi(1000, 8.5, 17356)).toEqual({ interest: 7, principal: 1000 });
  });

  it("the full schedule pays the loan off in 240 instalments", () => {
    const rows = buildSchedule(home, []);
    expect(rows).toHaveLength(240);
    expect(rows[0]).toMatchObject({ no: 1, dueOn: "2026-05-01", interest: 14167, principal: 3189, state: "due" });
    expect(rows[1].state).toBe("planned");
    expect(rows.at(-1)!.closing).toBe(0);
    expect(rows.reduce((s, r) => s + r.principal, 0)).toBe(2000000);
  });

  it("paid EMIs show first; a prepayment shortens the remaining schedule", () => {
    const pays: LoanPaymentLike[] = [
      { loan_id: "home", kind: "emi", paid_on: "2026-05-01", principal_part: 3189, interest_part: 14167 },
      { loan_id: "home", kind: "prepayment", paid_on: "2026-05-20", principal_part: 500000, interest_part: 0 },
    ];
    const rows = buildSchedule(home, pays);
    expect(rows[0]).toMatchObject({ state: "paid", no: 1 });
    expect(rows[1]).toMatchObject({ state: "paid", kind: "prepayment", no: 0, closing: 1496811 });
    expect(rows[2]).toMatchObject({ state: "due", no: 2, dueOn: "2026-06-01", opening: 1496811 });
    expect(rows.length).toBeLessThan(240);
    const s = summariseLoan(home, pays);
    expect(s.outstanding).toBe(1496811);
    expect(nextDue(home, s)).toMatchObject({ dueOn: "2026-06-01", instalmentNo: 2 });
  });

  it("interest-only: the next months are interest; principal stays", () => {
    const io: LoanLike = { ...bro, id: "io", annual_rate: 12, repay_type: "interest_only" };
    const rows = buildSchedule(io, [], 3);
    expect(rows.map((r) => [r.interest, r.principal, r.closing])).toEqual([
      [1000, 0, 100000], [1000, 0, 100000], [1000, 0, 100000],
    ]);
  });

  it("month ends clamp: 31 Jan + 1 month = 28 Feb", () => {
    expect(addMonthsISO("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsISO("2026-12-15", 2)).toBe("2027-02-15");
  });
});

describe("R-2388 totals for Net worth and the reminder", () => {
  it("given = asset, taken = liability, closed loans do not count; next EMI is the soonest", () => {
    const car: LoanLike = { ...home, id: "car", loan_kind: "car", principal: 500000, emi_amount: 10000, tenure_months: 60, start_date: "2026-03-10" };
    const closed: LoanLike = { ...bro, id: "old", status: "closed" };
    const pays: LoanPaymentLike[] = [
      { loan_id: "bro", kind: "repayment", paid_on: "2026-06-01", principal_part: 40000, interest_part: 0 },
    ];
    const t = loanTotals([home, bro, car, closed], pays);
    expect(t.givenOutstanding).toBe(60000);
    expect(t.takenOutstanding).toBe(2500000);
    expect(t.nextEmi).toMatchObject({ loanId: "car", dueOn: "2026-04-10" });
  });
});

describe("R-2388 FY summary for ITR (home loan)", () => {
  it("financial year runs April–March", () => {
    expect(financialYear("2027-02-10")).toEqual({ start: "2026-04-01", end: "2027-03-31", label: "2026-27" });
    expect(financialYear("2026-04-01").label).toBe("2026-27");
  });

  it("24(b) interest and 80C principal count only home loans taken, inside the FY", () => {
    const pays: LoanPaymentLike[] = [
      { loan_id: "home", kind: "emi", paid_on: "2026-05-01", principal_part: 3189, interest_part: 14167 },
      { loan_id: "home", kind: "prepayment", paid_on: "2026-06-01", principal_part: 100000, interest_part: 0 },
      { loan_id: "home", kind: "emi", paid_on: "2026-03-01", principal_part: 3000, interest_part: 14000 }, // last FY
      { loan_id: "bro", kind: "repayment", paid_on: "2026-06-01", principal_part: 40000, interest_part: 0 },
    ];
    expect(homeLoanItr([home, bro], pays, financialYear("2026-11-03"))).toEqual({ interest: 14167, principal: 103189, loans: 1 });
  });
});
