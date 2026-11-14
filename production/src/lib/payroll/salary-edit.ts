/**
 * R-2771 — change one booked salary month from wherever its row shows (Payroll → month, Salary
 * Register month view, Salary Register ?employee= FY view). Pure rules shared by the one row menu
 * (components/features/payroll/salary-row-actions.tsx) and the Pay salary form in edit mode.
 *
 * Nothing here computes salary, PF, ESI or TDS — Edit re-books the month through the SAME RPCs
 * as Payroll (delete_salary_payment, then pay_salary / pay_salary_with_arrears).
 */
import type { ArrearsSummary } from "./salary-revision";
import { periodLabel } from "./period-label";
import { formatDate } from "@/lib/utils";

/** The salary_payments fields these rules read. */
export type BookedSalary = {
  id: string;
  period: string;
  pay_date: string | null;
  gross: number;
  lop_days: number;
  lop_amount: number;
  incentive: number;
  arrears: number;
  advance_recovered: number;
  advance_loan_id: string | null;
  tds: number;
  pf: number;
  esi: number;
  pf_employer: number;
  esi_employer: number;
  pf_wage: number | null;
  other_deduction: number;
  bank_account_id: string | null;
  paid_amount: number;
  paid_status: string;
};

export type SalaryRowActionState = {
  /** Edit salary (reverse + book again with the form prefilled) — only before any bank line pays it. */
  edit: boolean;
  /** Undo salary — same rule (delete_salary_payment refuses once paid_amount > 0). */
  undo: boolean;
  /** R-2428: part-paid → set loss of pay so the net is what the bank paid (adjust_salary_lop). */
  adjustLop: boolean;
  /** Why Edit / Undo are not offered, said in the menu — null when they are. */
  lockReason: string | null;
  /** Why only Edit is not offered (Undo still is) — null when it is. */
  editNote: string | null;
};

/** Which salary actions a booked row offers. `canWrite` = canWriteMoney(role). */
export function salaryRowActionState(
  p: Pick<BookedSalary, "paid_amount" | "paid_status"> & Partial<Pick<BookedSalary, "advance_recovered" | "advance_loan_id" | "period">>,
  canWrite: boolean,
  /** `exitDate` = the employee's last working day (employees.exit_date), when they have left. */
  opts: { exitDate?: string | null } = {},
): SalaryRowActionState {
  if (p.paid_amount <= 0) {
    /* The advance this salary recovered from was deleted since: the form could not carry the
       recovery, and dropping it silently would raise the net — so no one-step Edit. */
    const lostAdvance = (p.advance_recovered ?? 0) > 0 && !p.advance_loan_id;
    /* A month after the exit month: the database refuses any new salary there (tg_salary_after_exit),
       so Save would reverse the run and then fail to book it — the month would be left unpaid. */
    const afterExit = Boolean(opts.exitDate && p.period && p.period > opts.exitDate.slice(0, 7));
    const editNote = lostAdvance
      ? "Edit not possible — its advance record was deleted. Undo salary, then pay again."
      : afterExit
      ? `Edit not possible — ${periodLabel(p.period!)} is after the last working day (${formatDate(opts.exitDate!)}). Undo salary if it should not be booked.`
      : null;
    return {
      edit: canWrite && !editNote, undo: canWrite, adjustLop: false, lockReason: null,
      editNote: canWrite ? editNote : null,
    };
  }
  return {
    editNote: null,
    edit: false,
    undo: false,
    adjustLop: canWrite && p.paid_status !== "paid",
    lockReason: p.paid_status === "paid"
      ? "Linked to a bank line — un-link it first to edit"
      : "Part-paid from a bank line — un-link it first for other changes",
  };
}

/** The Pay salary form's starting figures for an edit — exactly what is booked, so a one-field
 *  change is one field. Arrears ride inside `incentive` (pay_salary_with_arrears adds them), so the
 *  bonus box gets incentive − arrears and the arrears box the arrears. */
export function salaryEditPrefill(p: BookedSalary) {
  const arrears = Math.max(0, p.arrears ?? 0);
  return {
    gross: p.gross,
    bonus: Math.max(0, (p.incentive ?? 0) - arrears),
    arrears,
    lopDays: p.lop_days ?? 0,
    lopAmount: p.lop_amount ?? 0,
    advanceLoanId: p.advance_recovered > 0 ? p.advance_loan_id : null,
    advanceRecovered: p.advance_loan_id ? p.advance_recovered ?? 0 : 0,
    tds: p.tds ?? 0,
    pf: p.pf ?? 0,
    esi: p.esi ?? 0,
    pfEmployer: p.pf_employer ?? 0,
    esiEmployer: p.esi_employer ?? 0,
    pfWage: p.pf_wage,
    other: p.other_deduction ?? 0,
    payDate: p.pay_date,
    bankAccountId: p.bank_account_id,
  };
}

/** While the old row is still booked, its arrears count as paid; the edit may book them again
 *  (delete_salary_payment frees them first). Never more than was due. */
export function arrearsWhileEditing(summary: ArrearsSummary | null, rowArrears: number): ArrearsSummary | null {
  if (!summary || rowArrears <= 0) return summary;
  const paid = Math.max(0, summary.paid - rowArrears);
  return { ...summary, paid, outstanding: Math.max(0, summary.due - paid), overpaid: Math.max(0, paid - summary.due) };
}

/** A loan's outstanding while editing a salary that recovered from it: delete_salary_payment
 *  restores this salary's recovery, so the edit may recover it again. */
export function loanOutstandingWhileEditing(loan: { id: string; outstanding: number }, p: Pick<BookedSalary, "advance_loan_id" | "advance_recovered"> | null): number {
  if (p && p.advance_loan_id === loan.id && p.advance_recovered > 0) return loan.outstanding + p.advance_recovered;
  return loan.outstanding;
}

/** The month's salary was revised after this run was booked (R-2699 stores the salary in force on
 *  the row). `atRevised` = the booked gross scaled to the revised salary. Null when nothing changed.
 *
 *  `arrears` — may the form offer "Pay at the revised salary"? The raise for a booked month is paid
 *  ONCE: either as revision arrears with a later salary, or by re-booking the month at the revised
 *  salary — never both. "due" = none of this employee's revision arrears were paid yet (the offer is
 *  safe); "paid" = some were (it cannot be told which month they were for, so no offer); "unknown" =
 *  the arrears summary is not read yet (no offer until it is). `summary` is the summary as read
 *  (useSalaryArrears), not the edit-adjusted one. */
export function revisedSinceBookedInfo(
  p: { gross: number; salary_in_force?: number | null; period?: string } | null,
  monthGrossNow: number,
  summary?: Pick<ArrearsSummary, "paid"> | null,
): { bookedAt: number; atRevised: number; arrears: "due" | "paid" | "unknown" } | null {
  const bookedAt = p?.salary_in_force ?? null;
  if (!p || !bookedAt || bookedAt <= 0 || bookedAt === monthGrossNow) return null;
  return {
    bookedAt,
    atRevised: Math.round((p.gross * monthGrossNow) / bookedAt),
    arrears: !summary ? "unknown" : summary.paid > 0 ? "paid" : "due",
  };
}

export type RebookResult = { ok: true; oldRemoved: boolean } | { ok: false; oldRemoved: boolean; error: unknown };

/** Save on an edit: reverse the old run (delete_salary_payment — refused once a bank line pays it),
 *  then book the new figures (pay_salary / pay_salary_with_arrears). `oldId` null = the old run is
 *  already gone (an earlier Save removed it but booking failed) → only book. Never books when the
 *  undo was refused, so a month can never end up booked twice. */
export async function rebookSalary(
  oldId: string | null,
  steps: { undo: (id: string) => Promise<unknown>; pay: () => Promise<unknown> },
): Promise<RebookResult> {
  let oldRemoved = false;
  if (oldId) {
    try { await steps.undo(oldId); oldRemoved = true; }
    catch (error) { return { ok: false, oldRemoved: false, error }; }
  }
  try { await steps.pay(); }
  catch (error) { return { ok: false, oldRemoved, error }; }
  return { ok: true, oldRemoved };
}
