/**
 * R-2407 — a salary payout line that ALSO pays back money owed to the same employee (e.g. money
 * they paid the company by mistake, booked as "owed back" — a pending reimbursement with no
 * expense). The line = salary part + the payable; the salary part may be at most what is still due
 * on that salary. The DB function reconcile_salary_with_owed_back checks the same rules.
 */
import { samePerson } from "@/lib/accounting/employee-advance";

export interface OwedBackSalary { id: string; employee_id: string; employee_name: string; period: string; remaining: number }
export interface OwedBackPayable { id: string; person_name: string; employee_id: string | null; amount: number }
export interface OwedBackMatch<S extends OwedBackSalary, P extends OwedBackPayable> {
  salary: S;
  owed: P;
  /** What of the line pays the salary (line − owed back). */
  salaryPart: number;
  /** The salary part clears the salary in full. */
  exact: boolean;
}

function sameEmployee(s: OwedBackSalary, p: OwedBackPayable): boolean {
  return p.employee_id ? p.employee_id === s.employee_id : samePerson(p.person_name, s.employee_name);
}

/** Every (salary, payable of the same employee) pair this money-out line can pay; exact first. */
export function owedBackMatches<S extends OwedBackSalary, P extends OwedBackPayable>(
  lineAmount: number, salaries: readonly S[], payables: readonly P[],
): OwedBackMatch<S, P>[] {
  const out: OwedBackMatch<S, P>[] = [];
  for (const s of salaries) {
    if (s.remaining <= 0) continue;
    for (const p of payables) {
      if (p.amount <= 0 || !sameEmployee(s, p)) continue;
      const salaryPart = lineAmount - p.amount;
      if (salaryPart <= 0 || salaryPart > s.remaining) continue;
      out.push({ salary: s, owed: p, salaryPart, exact: salaryPart === s.remaining });
    }
  }
  return out.sort((a, b) => Number(b.exact) - Number(a.exact));
}
