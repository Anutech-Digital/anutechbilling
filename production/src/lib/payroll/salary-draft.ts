/* R-2892 — the figures the Pay salary form opens with, as ONE pure function.
   The Pay salary dialog keeps its own editable state; "Pay selected" (bulk) has no form, so it asks
   this file. Both read the same libs (salaryAutoDeductions, prorateSalary, salaryInForce, the
   attendance LOP rule) — there is no second salary formula. `lopSuggestionForMonth` is the one
   attendance → LOP-days rule the dialog's "Apply suggestion" button uses (moved here from the
   dialog, same code). */
import { daysElapsedInPeriod, prorateSalary } from "@/lib/payroll/proration";
import { exitPayDays, type ExitLike } from "@/lib/payroll/exit";
import { nationalHolidaysForYear } from "@/lib/payroll/holidays-india";
import { salaryAutoDeductions, type PayslipFacts } from "@/lib/payroll/net-pay";
import { arrearsPayableIn, salaryInForce, type ArrearsSummary, type SalaryRevision, type SalaryStructure } from "@/lib/payroll/salary-revision";
import { leaveDaysInMonth, presentByDate, presentSummary, suggestedLopDays, type AttendanceDayRow, type LeaveRow } from "@/lib/attendance/lop";
import { DEFAULT_SHIFT, type ShiftRules } from "@/lib/attendance/shift";
import { utcDateISO } from "@/lib/dates/ist";

export interface LopSuggestion {
  present: number; halfDays: number; absent: number; unpaidLeave: number; lopDays: number;
  workingDays: number; sundays: number; holidays: number;
}

/** Loss-of-pay days attendance + unpaid leave suggest for `period` (Sundays / holidays never count). */
export function lopSuggestionForMonth(i: {
  period: string;
  employee: ExitLike & { id: string };
  todayIso: string;
  companyHolidays: readonly string[];
  attendance: readonly AttendanceDayRow[];
  leaves: readonly LeaveRow[];
  rules?: ShiftRules;
}): LopSuggestion {
  const { period, employee } = i;
  const [yy, mm] = period.split("-").map(Number);
  const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
  const monthEnd = new Date(Date.UTC(yy, mm, 0));
  const todayUTC = new Date(i.todayIso + "T00:00:00Z");
  /* R-1896: days after the last working day are not absences. */
  const exitDay = exitPayDays(employee, period)?.lastDay;
  const lastDayUTC = exitDay ? new Date(exitDay + "T00:00:00Z") : monthEnd;
  const capEnd = lastDayUTC < monthEnd ? lastDayUTC : monthEnd;
  const rangeEnd = todayUTC < capEnd ? todayUTC : capEnd;
  const rangeStart = employee.joining_date && employee.joining_date > `${period}-01`
    ? new Date(employee.joining_date + "T00:00:00Z") : monthStart;
  // Company holidays + auto national gazetted holidays (26 Jan / 15 Aug / 2 Oct).
  const holidaySet = new Set(i.companyHolidays);
  nationalHolidaysForYear(yy).forEach((d) => holidaySet.add(d));
  let expected = 0, sundays = 0, holidays = 0;
  const countedDates = new Set<string>();
  for (const d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = utcDateISO(d);
    if (d.getUTCDay() === 0) sundays++;            // weekly off — paid, never LOP
    else if (holidaySet.has(iso)) holidays++;      // Sunday/holiday clash counts once as Sunday
    else { expected++; countedDates.add(iso); }     // working day
  }
  // R-604: a half-day counts 0.5 present.
  const rules = i.rules ?? DEFAULT_SHIFT;
  const { present, halfDays } = presentSummary(i.attendance, employee.id, rules);
  // R-780: only the leave's working days inside this month, never on a present day, never twice.
  const isWorkingDate = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0
    && !holidaySet.has(iso) && !nationalHolidaysForYear(Number(iso.slice(0, 4))).includes(iso);
  const { paidLeave, unpaidLeave } = leaveDaysInMonth({
    leaves: i.leaves, employeeId: employee.id, countedDates, isWorkingDate,
    presentByDate: presentByDate(i.attendance, employee.id, rules),
  });
  const { absent, lopDays } = suggestedLopDays({ expected, present, paidLeave, unpaidLeave });
  return { present, halfDays, absent, unpaidLeave, lopDays, workingDays: expected, sundays, holidays };
}

/** The employee fields the draft reads. */
export interface DraftEmployee extends ExitLike, SalaryStructure {
  id: string;
  name: string;
  pf_applicable: boolean;
  pf_full_wage?: boolean | null;
  esi_applicable: boolean;
}

export interface SalaryDraft {
  period: string;
  monthGross: number;
  /** Days the "salary to pay" covers — a month not over yet pays only the days so far (as the form does). */
  payDays: { elapsed: number; daysInMonth: number; complete: boolean };
  gross: number;
  lopDays: number;
  lopAmount: number;
  arrears: number;
  tds: number;
  pf: number;
  esi: number;
  pfEmployer: number;
  esiEmployer: number;
  pfWage: number | null;
  /** earned − TDS − PF − ESI (no bonus, no advance recovery, no other deduction in a bulk run). */
  net: number;
}

/** What Pay salary opens with for this employee and month, LOP from attendance applied. */
export function buildSalaryDraft(i: {
  employee: DraftEmployee;
  period: string;
  todayIso: string;
  revisions: readonly SalaryRevision[];
  /** This employee's payslips (ESI contribution period, TDS already deducted). */
  history: readonly PayslipFacts[];
  arrears: ArrearsSummary | null;
  lop: Pick<LopSuggestion, "lopDays">;
}): SalaryDraft {
  const { employee, period } = i;
  const inForce = salaryInForce(employee, i.revisions, period);
  const monthGross = inForce.monthly_gross;
  /* R-1896: in the exit month pay only up to the last working day. */
  const exitPay = exitPayDays(employee, period);
  const monthSoFar = daysElapsedInPeriod(period, i.todayIso);
  const payDays = exitPay
    ? { elapsed: Math.min(monthSoFar.elapsed, exitPay.days), daysInMonth: monthSoFar.daysInMonth, complete: false }
    : monthSoFar;
  const gross = payDays.complete ? monthGross : prorateSalary(monthGross, payDays.elapsed, payDays.daysInMonth);
  const lopDays = i.lop.lopDays;
  const lopAmount = Math.max(0, Math.round((monthGross / payDays.daysInMonth) * lopDays));
  /* R-2699: revision arrears ride only on a month after the months they are for. */
  const arrears = i.arrears && arrearsPayableIn(i.arrears, period) ? i.arrears.outstanding : 0;
  const auto = salaryAutoDeductions({
    period, gross, lopAmount, extraEarned: arrears, monthGross,
    basic: inForce.basic_monthly, da: inForce.da_monthly,
    pfApplicable: employee.pf_applicable, pfFullWage: Boolean(employee.pf_full_wage), esiApplicable: employee.esi_applicable,
    monthlyGrossAhead: employee.monthly_gross,
    history: i.history,
  });
  const tds = auto.tds.thisMonth, pf = auto.pf.employee, esi = auto.esi.employee;
  const net = Math.max(0, gross - lopAmount) + arrears - tds - pf - esi;
  return {
    period, monthGross, payDays, gross, lopDays, lopAmount, arrears, tds, pf, esi,
    pfEmployer: auto.pf.employer, esiEmployer: auto.esi.employer,
    pfWage: employee.pf_applicable ? auto.pf.base : null,
    net,
  };
}
