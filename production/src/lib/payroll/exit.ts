/**
 * R-1896 — an employee who leaves. Pure rules, read at the time of use (no cron).
 *
 * `exit_date` on the employee is the LAST WORKING DAY. Everything follows from that one date:
 *  - status: "exiting" through the last day, "exited" from the next day (even if `is_active`
 *    was never flipped — nothing has to run at midnight);
 *  - payroll: the person appears up to and including the exit month, never after it
 *    (the database refuses a later payslip too — trg_salary_after_exit);
 *  - the exit month is paid pro-rata up to the last day;
 *  - their login ends after that day (users.access_ends_on, current_tenant_id()).
 */
import { addDaysISO } from "@/lib/dates/ist";

export type ExitReason = "resigned" | "terminated" | "retired" | "absconding" | "death" | "contract_ended" | "other";

/** Same list and order as the employees_exit_reason_check constraint. */
export const EXIT_REASONS: { value: ExitReason; label: string }[] = [
  { value: "resigned", label: "Resigned" },
  { value: "terminated", label: "Terminated" },
  { value: "retired", label: "Retired" },
  { value: "absconding", label: "Absconding" },
  { value: "death", label: "Death" },
  { value: "contract_ended", label: "Contract ended" },
  { value: "other", label: "Other" },
];

export const exitReasonLabel = (r: string | null | undefined): string =>
  EXIT_REASONS.find((x) => x.value === r)?.label ?? "Other";

export interface ExitLike {
  is_active: boolean;
  joining_date?: string | null;
  exit_date?: string | null;
}

export type EmploymentStatus = "active" | "exiting" | "exited" | "inactive";

/** `today` = IST YYYY-MM-DD. */
export function employmentStatus(e: ExitLike, today: string): EmploymentStatus {
  if (e.exit_date) return e.exit_date < today ? "exited" : "exiting";
  return e.is_active ? "active" : "inactive";
}

/** Still working here today (active or serving notice) — the list for kiosks, advances, pickers. */
export function isCurrentEmployee(e: ExitLike, today: string): boolean {
  const s = employmentStatus(e, today);
  return s === "active" || s === "exiting";
}

/** Does this employee belong in the payroll of `period` (YYYY-MM)? */
export function onPayrollFor(e: ExitLike, period: string): boolean {
  if (e.joining_date && e.joining_date.slice(0, 7) > period) return false;
  /* The exit month stays even after the last day (the final salary is still to be run),
     and even when the database already flipped is_active. */
  if (e.exit_date) return period <= e.exit_date.slice(0, 7);
  return e.is_active;
}

/** In the exit month: pay days up to the last working day. Other months: null. */
export function exitPayDays(e: ExitLike, period: string): { days: number; daysInMonth: number; lastDay: string } | null {
  if (!e.exit_date || e.exit_date.slice(0, 7) !== period) return null;
  const [y, m] = period.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { days: Number(e.exit_date.slice(8, 10)), daysInMonth, lastDay: e.exit_date };
}

/** Days of notice served (resignation day counted) and the shortfall against policy. */
export function noticeShortfall(i: { resignationDate: string; lastDay: string; noticeDays: number }): { served: number; short: number } {
  const ms = Date.parse(i.lastDay + "T00:00:00Z") - Date.parse(i.resignationDate + "T00:00:00Z");
  const served = Math.max(0, Math.round(ms / 86_400_000) + 1);
  return { served, short: Math.max(0, i.noticeDays - served) };
}

/** Last working day if the full notice is served. */
export function defaultLastDay(resignationDate: string, noticeDays: number): string {
  return addDaysISO(resignationDate, Math.max(0, noticeDays - 1));
}
