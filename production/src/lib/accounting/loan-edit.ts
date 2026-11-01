/**
 * R-2339 — edit or delete a loan set up from an EMI line (R-2323, emi_purchases.kind = 'loan').
 *
 * A typing mistake in the lender, rate, EMIs left or EMI amount is fixed in place instead of
 * undoing everything:
 *  - paid EMIs are never touched (their split is already in the books);
 *  - the principal still owed stays as it is;
 *  - the UNPAID part of the schedule is rebuilt with the same reducing-balance rule as the
 *    set-up (loan-setup.ts → emi-schedule.ts buildSchedule): the bank's EMI is kept, each
 *    month's interest is worked out on the balance still owed, the last EMI clears what is left.
 *    It starts at the next unpaid instalment, on its due date.
 * The database (edit_emi_loan, migration r2339) re-checks every row against the stored balance
 * and the new rate, so a stale screen cannot write a wrong schedule.
 *
 * Delete (delete_emi_loan) is only for a loan with no EMI paid: it removes the loan and its
 * schedule and gives back its money-in line (imported line → unmatched again; manual line made
 * at set-up → removed).
 */
import { buildSchedule, emiFor, scheduleTotals, toRpcRows, type ScheduleRow } from "./emi-schedule";

export type LoanEditInput = {
  lender: string;
  lenderRef?: string | null;
  annualRatePct: number;
  months: number;            // EMIs left, counting the next unpaid one
  emi: number | null;        // the bank's EMI; null → the standard EMI
};

/** Where the unpaid part starts — read off the loan's schedule. */
export type LoanEditBase = {
  outstanding: number;       // principal still owed (financed − principal paid)
  nextSeq: number;           // the first unpaid instalment
  nextDueOn: string;         // its due date (kept)
};

export type ScheduleLike = { seq: number; due_on: string; emi_payment_id: string | null };

/** The next unpaid instalment of a loan, or null when every row is paid. */
export function loanEditBase(rows: ScheduleLike[], outstanding: number): LoanEditBase | null {
  const next = rows.filter((r) => !r.emi_payment_id).sort((a, b) => a.seq - b.seq)[0];
  if (!next || outstanding <= 0) return null;
  return { outstanding, nextSeq: next.seq, nextDueOn: next.due_on };
}

export function loanEditSchedule(base: LoanEditBase, i: LoanEditInput): {
  rows: ScheduleRow[]; emi: number; lastEmi: number; totalInterest: number; error: string | null;
} {
  const months = Math.round(i.months);
  const emi = i.emi && i.emi > 0 ? Math.round(i.emi) : emiFor(base.outstanding, i.annualRatePct, months);
  try {
    const rows = buildSchedule({
      principal: base.outstanding, annualRatePct: i.annualRatePct, months, firstDueOn: base.nextDueOn,
      emi, startSeq: base.nextSeq,
    });
    return {
      rows, emi, lastEmi: rows.length ? rows[rows.length - 1].emi : 0,
      totalInterest: scheduleTotals(rows).interest, error: null,
    };
  } catch (e) {
    return { rows: [], emi, lastEmi: 0, totalInterest: 0, error: e instanceof Error ? e.message : "Check the EMI" };
  }
}

export function loanEditErrors(i: LoanEditInput): string[] {
  const out: string[] = [];
  if (!i.lender.trim()) out.push("Enter the lender (bank / NBFC)");
  if (!(i.annualRatePct >= 0 && i.annualRatePct <= 60)) out.push("Enter the interest rate (0 to 60% a year)");
  if (!(i.months > 0) || !Number.isInteger(i.months)) out.push("Enter how many EMIs are left");
  if (i.emi !== null && !(i.emi > 0)) out.push("Enter the EMI the bank takes");
  return out;
}

export function loanEditPayload(purchaseId: string, i: LoanEditInput, rows: ScheduleRow[]) {
  return {
    purchase_id: purchaseId,
    lender: i.lender.trim(),
    lender_ref: i.lenderRef?.trim() || null,
    interest_rate: i.annualRatePct,
    schedule: toRpcRows(rows),
  };
}

/** Delete is offered only while no EMI of the loan is paid (the database refuses it too). */
export const canDeleteEmiLoan = (l: { emisPaid: number }) => l.emisPaid === 0;
