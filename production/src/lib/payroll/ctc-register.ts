/**
 * CTC register — "actual this FY" figures, read from the FY's payslips (R-1585).
 *
 * The CTC structure columns say what an employee is set to cost; these say what they DID cost
 * in the financial year: salary earned (gross − LOP + incentive) plus the employer PF and ESI
 * booked on each payslip. Totals are the plain sum of the payslips — nothing re-computed.
 */
import { fyStartYear } from "@/lib/dates/ist";

export interface PayslipForActuals {
  employee_id: string;
  period: string; // YYYY-MM
  gross: number;
  lop_amount: number;
  incentive: number;
  pf: number;
  esi: number;
  pf_employer: number;
  esi_employer: number;
  net: number;
}

export interface FyActuals {
  months: number;
  gross: number;
  earned: number; // gross − LOP + incentive
  employeePf: number;
  employeeEsi: number;
  employerPf: number;
  employerEsi: number;
  net: number;
  cost: number; // earned + employer PF + employer ESI
}

const zero = (): FyActuals => ({ months: 0, gross: 0, earned: 0, employeePf: 0, employeeEsi: 0, employerPf: 0, employerEsi: 0, net: 0, cost: 0 });

function add(t: FyActuals, p: PayslipForActuals): void {
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const earned = Math.max(0, n(p.gross) - n(p.lop_amount)) + n(p.incentive);
  t.months += 1;
  t.gross += n(p.gross);
  t.earned += earned;
  t.employeePf += n(p.pf);
  t.employeeEsi += n(p.esi);
  t.employerPf += n(p.pf_employer);
  t.employerEsi += n(p.esi_employer);
  t.net += n(p.net);
  t.cost += earned + n(p.pf_employer) + n(p.esi_employer);
}

/** Per-employee and total actuals for the FY that starts in April of `fyStart`. */
export function fyPayslipActuals(payslips: readonly PayslipForActuals[], fyStart: number): { byEmployee: Map<string, FyActuals>; totals: FyActuals } {
  const byEmployee = new Map<string, FyActuals>();
  const totals = zero();
  for (const p of payslips) {
    if (fyStartYear(p.period) !== fyStart) continue;
    let t = byEmployee.get(p.employee_id);
    if (!t) { t = zero(); byEmployee.set(p.employee_id, t); }
    add(t, p);
    add(totals, p);
  }
  return { byEmployee, totals };
}
