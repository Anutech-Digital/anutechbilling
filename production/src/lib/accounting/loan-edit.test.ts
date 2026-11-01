/**
 * R-2339 — edit a loan set up from an EMI line: only the unpaid part of the schedule changes.
 *
 * Owner example (R-2323's bike loan): ₹2,50,000 at 11%, 14 EMIs of ₹19,054 from 5 Oct 2026.
 * EMI 1 is reconciled (₹16,762 principal) → ₹2,33,238 still owed, EMI 2 due 5 Nov 2026.
 * The rate was a typing mistake: the loan letter says 10.5%.
 */
import { describe, expect, it } from "vitest";
import { scheduleTotals } from "./emi-schedule";
import { canDeleteEmiLoan, loanEditBase, loanEditErrors, loanEditPayload, loanEditSchedule, type LoanEditInput } from "./loan-edit";

const base = { outstanding: 233238, nextSeq: 2, nextDueOn: "2026-11-05" };
const edit = (over: Partial<LoanEditInput> = {}): LoanEditInput => ({
  lender: "HDFC Bank", annualRatePct: 10.5, months: 13, emi: 19054, ...over,
});

describe("loanEditBase — where the unpaid part starts", () => {
  it("the first unpaid instalment and its due date; paid rows are skipped", () => {
    const rows = [
      { seq: 3, due_on: "2026-12-05", emi_payment_id: null },
      { seq: 1, due_on: "2026-10-05", emi_payment_id: "pay-1" },
      { seq: 2, due_on: "2026-11-05", emi_payment_id: null },
    ];
    expect(loanEditBase(rows, 233238)).toEqual(base);
  });
  it("nothing left to change when every row is paid or nothing is owed", () => {
    expect(loanEditBase([{ seq: 1, due_on: "2026-10-05", emi_payment_id: "p" }], 0)).toBeNull();
    expect(loanEditBase([{ seq: 2, due_on: "2026-11-05", emi_payment_id: null }], 0)).toBeNull();
  });
});

describe("loanEditSchedule — same reducing-balance rule as the set-up", () => {
  it("rate 11% → 10.5%: starts at EMI 2 on its date, bank EMI kept, interest on ₹2,33,238, last EMI clears", () => {
    const s = loanEditSchedule(base, edit());
    expect(s.error).toBeNull();
    expect(s.rows).toHaveLength(13);
    // 10.5% / 12 of ₹2,33,238 = ₹2,040.83 → ₹2,041 interest; ₹17,013 off the loan.
    expect(s.rows[0]).toEqual({ seq: 2, dueOn: "2026-11-05", emi: 19054, principal: 17013, interest: 2041, balanceAfter: 216225 });
    for (const r of s.rows.slice(0, 12)) expect(r.emi).toBe(19054);
    expect(s.rows[12]).toMatchObject({ seq: 14, dueOn: "2027-11-05", emi: 19129, balanceAfter: 0 });
    expect(s.lastEmi).toBe(19129);
    // The principal still owed is unchanged — the new rows repay exactly ₹2,33,238.
    expect(scheduleTotals(s.rows).principal).toBe(233238);
    expect(s.totalInterest).toBe(14539);
  });

  it("no EMI typed → the standard EMI for what is owed over the EMIs left", () => {
    const s = loanEditSchedule(base, edit({ annualRatePct: 11, months: 10, emi: null }));
    expect(s.emi).toBe(24516);
    expect(s.rows).toHaveLength(10);
    expect(s.rows[9]).toMatchObject({ seq: 11, emi: 24514, balanceAfter: 0 });
  });

  it("an EMI that cannot even pay the month's interest is refused, no schedule", () => {
    const s = loanEditSchedule(base, edit({ annualRatePct: 11, emi: 1000 }));
    expect(s.rows).toEqual([]);
    expect(s.error).toMatch(/does not cover the month's interest/);
  });
});

describe("loanEditErrors / payload / delete rule", () => {
  it("plain messages for missing fields", () => {
    expect(loanEditErrors(edit({ lender: " ", annualRatePct: 61, months: 0, emi: -5 }))).toEqual([
      "Enter the lender (bank / NBFC)", "Enter the interest rate (0 to 60% a year)",
      "Enter how many EMIs are left", "Enter the EMI the bank takes",
    ]);
    expect(loanEditErrors(edit())).toEqual([]);
  });
  it("payload: trimmed lender, the rows in the database's shape", () => {
    const s = loanEditSchedule(base, edit());
    const p = loanEditPayload("p1", edit({ lender: "  HDFC Bank ", lenderRef: " " }), s.rows);
    expect(p).toMatchObject({ purchase_id: "p1", lender: "HDFC Bank", lender_ref: null, interest_rate: 10.5 });
    expect(p.schedule[0]).toEqual({ seq: 2, due_on: "2026-11-05", emi: 19054, principal: 17013, interest: 2041, balance_after: 216225 });
  });
  it("delete only while no EMI is paid", () => {
    expect(canDeleteEmiLoan({ emisPaid: 0 })).toBe(true);
    expect(canDeleteEmiLoan({ emisPaid: 1 })).toBe(false);
  });
});
