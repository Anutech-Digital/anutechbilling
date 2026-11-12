/**
 * R-2701 (12 Nov 2026, Hitesh's report item 7): "employee can't be removed, salary already booked"
 * — but nobody could see WHICH months. Read-only helpers for the employee profile's
 * "Salary & payments" section and the delete refusal. No money logic: the figures are the stored
 * salary_payments columns; the paid state is drawn by the Salary Register's own SalaryStatusCell (R-1831).
 *
 *   gross       = gross + bonus (incentive)
 *   deductions  = LOP (at most the gross) + advance recovered + TDS + PF + ESI + other
 *                 (pay_salary: earned = greatest(gross − LOP, 0) + bonus; net = earned − the rest)
 *   net         = the stored net (in-hand)
 */
import { formatMonthLabel } from "@/lib/dates/ist";

/** The salary_payments columns this needs (a SalaryPayment row has them all). */
export type SalaryMonthFacts = {
  id: string;
  period: string;
  gross: number;
  incentive: number;
  lop_amount: number;
  advance_recovered: number;
  tds: number;
  pf: number;
  esi: number;
  other_deduction: number;
  net: number;
  paid_amount: number;
  paid_status: string;
  reconciled_txn_id: string | null;
  expense_id: string | null;
};

export type SalaryMonthRow = {
  id: string;
  period: string;
  /** "Sep 2026" */
  month: string;
  gross: number;
  deductions: number;
  net: number;
};

const n = (x: number | null | undefined) => Number(x) || 0;

/** One line per booked salary, newest month first. */
export function salaryMonthRows(rows: readonly SalaryMonthFacts[]): SalaryMonthRow[] {
  return [...rows]
    .sort((a, b) => b.period.localeCompare(a.period) || b.id.localeCompare(a.id))
    .map((p) => ({
      id: p.id,
      period: p.period,
      month: formatMonthLabel(p.period),
      gross: n(p.gross) + n(p.incentive),
      deductions: Math.min(n(p.lop_amount), n(p.gross)) + n(p.advance_recovered) + n(p.tds) + n(p.pf) + n(p.esi) + n(p.other_deduction),
      net: n(p.net),
    }));
}

/** The nets to look up an unlinked bank line for (the Salary Register's rule, R-1895): unpaid salaries
 *  ("Paid — link bank line") and a Paid salary with no bank line on record (its Match). */
export function waitingSalaryNets(rows: readonly Pick<SalaryMonthFacts, "net" | "paid_amount" | "paid_status" | "reconciled_txn_id">[]): number[] {
  return rows.filter((p) => p.paid_amount === 0 || (p.paid_status === "paid" && !p.reconciled_txn_id)).map((p) => p.net);
}

const MAX_NAMED = 6;

/** "Sep 2026 and Oct 2026" — unique months, oldest first; past 6, "… and N more months". */
export function bookedMonthsText(periods: readonly string[]): string {
  const months = [...new Set(periods)].sort().map((p) => formatMonthLabel(p));
  if (months.length === 0) return "";
  if (months.length === 1) return months[0];
  if (months.length > MAX_NAMED) {
    const more = months.length - MAX_NAMED;
    return `${months.slice(0, MAX_NAMED).join(", ")} and ${more} more month${more > 1 ? "s" : ""}`;
  }
  return `${months.slice(0, -1).join(", ")} and ${months[months.length - 1]}`;
}

/** The delete refusal body (the title names the employee): how many months, which ones, what to do instead. */
export function deleteBlockedMessage(periods: readonly string[]): string {
  const count = new Set(periods).size;
  return `Salary is booked for ${count} month${count === 1 ? "" : "s"} (${bookedMonthsText(periods)}). `
    + "Deleting would break those payslips and their bank links. Use Start exit instead — it marks them as left; their history stays and payroll stops after their last working day.";
}

const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Loans / salary advances are stored by employee name (employee_loans.employee_name). Newest first. */
export function employeeLoansFor<T extends { employee_name: string; disbursed_on: string }>(loans: readonly T[], employeeName: string): T[] {
  const key = nameKey(employeeName);
  return loans
    .filter((l) => nameKey(l.employee_name) === key)
    .sort((a, b) => b.disbursed_on.localeCompare(a.disbursed_on));
}

/** What this employee still owes on loans / salary advances (whole rupees). */
export function outstandingLoanTotal(loans: readonly { outstanding: number }[]): number {
  return loans.reduce((sum, l) => sum + Math.max(0, n(l.outstanding)), 0);
}
