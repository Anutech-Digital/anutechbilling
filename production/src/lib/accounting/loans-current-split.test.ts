import { describe, it, expect } from "vitest";
import { loansAdvancesSplit, loansCurrentFromRpc, loanSplitLines, loanSplitLineHint, loanGivenSplitNote } from "./loans-current-split";
import { loanSchedule, type LoanTerms } from "./loans-given";

describe("R-2674 loansAdvancesSplit — one split for Balance Sheet lines, ratio and CSV", () => {
  it("older database (no loansCurrent) → everything non-current, as before", () => {
    const s = loansAdvancesSplit({ loansGiven: 2_980_000, employeeLoans: 800_000 });
    expect(s.current).toBe(0);
    expect(s.nonCurrent).toBe(3_780_000);
    expect(s.given).toEqual({ total: 2_980_000, current: 0, nonCurrent: 2_980_000 });
    expect(s.known).toBe(false);
    // …and the sheet / CSV keep the plain old lines — nothing is claimed about due dates
    expect(loanSplitLines(s)).toEqual([
      { key: "staff", place: "plain", current: false, label: "Employee loans", amount: 800_000 },
      { key: "given", place: "plain", current: false, label: "Loans given", amount: 2_980_000 },
    ]);
    expect(loanSplitLineHint({ key: "given", place: "plain" }, 0)).toBe("lent to outside parties, still owed back");
  });

  it("a loan with no due date and no answer is its own line — never printed as 'due after 12 months'", () => {
    const s = loansAdvancesSplit({
      loansGiven: 965_010, employeeLoans: 0,
      loansCurrent: { loansGiven: 334_446, employeeLoans: 0, undecidedCount: 1, undecidedAmount: 300_000 },
    });
    expect(loanSplitLines(s).map((l) => [l.place, l.label, l.amount])).toEqual([
      ["current", "Loans given — current (due within 12 months)", 334_446],
      ["non_current", "Loans given — non-current (due after 12 months)", 330_564],
      ["undecided", "Loans given — no due date, not answered (counted as non-current)", 300_000],
    ]);
    expect(loanSplitLineHint({ key: "given", place: "undecided" }, 1)).toBe('1 loan with no due date — the owner or accountant answers "Due back within 12 months?" on Loans given');
    expect(loanSplitLineHint({ key: "given", place: "undecided" }, 3)).toMatch(/^3 loans with no due date/);
  });

  it("owner's example: loans ₹29.8L + staff ₹8L answered current → all of it current, totals unchanged", () => {
    const s = loansAdvancesSplit({
      loansGiven: 2_980_000, employeeLoans: 800_000,
      loansCurrent: { loansGiven: 2_980_000, employeeLoans: 800_000, undecidedCount: 0, undecidedAmount: 0 },
    });
    expect(s.current).toBe(3_780_000);
    expect(s.nonCurrent).toBe(0);
    expect(s.given.current + s.given.nonCurrent).toBe(2_980_000);
    expect(s.staff.current + s.staff.nonCurrent).toBe(800_000);
  });

  it("part current, part non-current — the two always add up to the old line", () => {
    const s = loansAdvancesSplit({
      loansGiven: 965_010, employeeLoans: 720_000,
      loansCurrent: { loansGiven: 334_446, employeeLoans: 20_000, undecidedCount: 1, undecidedAmount: 300_000 },
    });
    expect(s.given).toEqual({ total: 965_010, current: 334_446, nonCurrent: 630_564 });
    expect(s.staff).toEqual({ total: 720_000, current: 20_000, nonCurrent: 700_000 });
    expect(s.undecidedCount).toBe(1);
    expect(s.undecidedAmount).toBe(300_000);
  });

  it("current is clamped to the Balance Sheet total (over-repaid books, stale figures, negatives)", () => {
    const s = loansAdvancesSplit({
      loansGiven: 3_000, employeeLoans: 0,
      loansCurrent: { loansGiven: 10_000, employeeLoans: 5_000, undecidedCount: 2, undecidedAmount: 9_000 },
    });
    expect(s.given).toEqual({ total: 3_000, current: 3_000, nonCurrent: 0 });
    expect(s.staff).toEqual({ total: 0, current: 0, nonCurrent: 0 });
    expect(s.undecidedAmount).toBe(0);
    expect(s.undecidedCount).toBe(0);
    expect(loansAdvancesSplit({ loansGiven: -5, employeeLoans: 100, loansCurrent: { loansGiven: -1, employeeLoans: -1, undecidedCount: 0, undecidedAmount: 0 } }).current).toBe(0);
    expect(loansAdvancesSplit(undefined).current).toBe(0);
  });

  it("reads the RPC row (numbers or numeric strings; junk → 0)", () => {
    expect(loansCurrentFromRpc({ loans_given_current: "334446", employee_loans_current: 720000, loans_given_undecided: 1, loans_given_undecided_amount: "300000" }))
      .toEqual({ loansGiven: 334_446, employeeLoans: 720_000, undecidedCount: 1, undecidedAmount: 300_000 });
    expect(loansCurrentFromRpc(null)).toEqual({ loansGiven: 0, employeeLoans: 0, undecidedCount: 0, undecidedAmount: 0 });
    expect(loansCurrentFromRpc({ loans_given_current: "abc", employee_loans_current: -4 })).toMatchObject({ loansGiven: 0, employeeLoans: 0 });
  });

  it("csv / sheet lines: only parts that hold money, and they add up to the two old lines", () => {
    const s = loansAdvancesSplit({
      loansGiven: 965_010, employeeLoans: 720_000,
      loansCurrent: { loansGiven: 334_446, employeeLoans: 720_000, undecidedCount: 0, undecidedAmount: 0 },
    });
    const lines = loanSplitLines(s);
    expect(lines.map((l) => l.label)).toEqual([
      "Employee loans — current (due within 12 months)",
      "Loans given — current (due within 12 months)",
      "Loans given — non-current (due after 12 months)",
    ]);
    expect(lines.reduce((t, l) => t + l.amount, 0)).toBe(965_010 + 720_000);
    expect(lines.filter((l) => l.current).reduce((t, l) => t + l.amount, 0)).toBe(s.current);
    expect(loanSplitLines(loansAdvancesSplit({ loansGiven: 0, employeeLoans: 0 }))).toEqual([]);
    expect(loanSplitLines(loansAdvancesSplit({ loansGiven: 0, employeeLoans: 0, loansCurrent: { loansGiven: 0, employeeLoans: 0, undecidedCount: 0, undecidedAmount: 0 } }))).toEqual([]);
  });

  it("the note on a Loans given card", () => {
    expect(loanGivenSplitNote({ principal_left: 100, current_part: 0, basis: "undecided" })).toMatch(/until you answer/);
    expect(loanGivenSplitNote({ principal_left: 100, current_part: 100, basis: "choice" })).toBe("Balance Sheet: current (due within 12 months)");
    expect(loanGivenSplitNote({ principal_left: 100, current_part: 0, basis: "schedule" })).toBe("Balance Sheet: non-current (due after 12 months)");
    expect(loanGivenSplitNote({ principal_left: 100, current_part: 40, basis: "schedule" }, (n) => `₹${n}`))
      .toBe("Balance Sheet: ₹40 current (due within 12 months) · ₹60 non-current");
    expect(loanGivenSplitNote({ principal_left: 0, current_part: 0, basis: "schedule" })).toBeNull();
    expect(loanGivenSplitNote(undefined)).toBeNull();
  });
});

/**
 * The SQL rule (loan_given_current_principal) and the app's schedule (loanSchedule) must give the
 * same rupees — these are the figures supabase/tests/r2674_loans_current_split.test.sql asserts
 * (cases B and C), worked out here from the TS schedule for a Balance Sheet dated 31 Mar 2026.
 */
describe("R-2674 SQL figures = the app schedule's figures", () => {
  const cutoff = "2027-03-31";
  const currentOf = (t: LoanTerms, repaid: number) =>
    loanSchedule(t, repaid, "2026-03-31").filter((r) => r.dueOn !== null && r.dueOn <= cutoff).reduce((s, r) => s + r.unpaid, 0);

  it("B: 24 instalments of ₹2,40,010 from 30 Apr 2026, ₹25,000 repaid → ₹95,000 current", () => {
    expect(currentOf({ principal: 240_010, givenOn: "2025-06-01", interestRate: 0, plan: "instalments", dueOn: "2026-04-30", instalments: 24 }, 25_000)).toBe(95_000);
  });

  it("C: EMI ₹1,20,000 @ 12%, ₹10,662 × 12 from 5 May 2026 → ₹1,09,446 current, last receipt ₹10,554 non-current", () => {
    const t: LoanTerms = { principal: 120_000, givenOn: "2025-06-01", interestRate: 12, plan: "emi", dueOn: "2026-05-05", instalments: 12, emi: 10_662 };
    expect(currentOf(t, 0)).toBe(109_446);
    const rows = loanSchedule(t, 0, "2026-03-31");
    expect(rows[rows.length - 1]).toMatchObject({ dueOn: "2027-04-05", principal: 10_554 });
  });

  it("instalment rounding: ₹100 in 3 from 28 Feb 2027 → 33 + 33 current, 34 later; ₹40 repaid comes off the first parts", () => {
    const t: LoanTerms = { principal: 100, givenOn: "2026-01-01", interestRate: 0, plan: "instalments", dueOn: "2027-02-28", instalments: 3 };
    expect(currentOf(t, 0)).toBe(66);
    expect(currentOf(t, 40)).toBe(26);
  });
});
