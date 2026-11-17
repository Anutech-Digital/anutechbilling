/* R-2892 — "Pay selected" on Run payroll. Pure planning + a sequential runner; the money maths is
   buildSalaryDraft (the figures Pay salary opens with) and the booking is the SAME mutation the
   single Pay salary button uses (usePaySalary → pay_salary / pay_salary_with_arrears). */
import type { DraftEmployee, SalaryDraft } from "@/lib/payroll/salary-draft";

/** The exact input usePaySalary's mutation takes. */
export interface BulkPayInput {
  employeeId: string; period: string; payDate: string; gross: number;
  lopDays: number; lopAmount: number; incentive?: number; advanceRecovered: number; advanceLoanId?: string | null;
  tds: number; pf: number; esi: number; esiEmployer?: number; pfEmployer?: number; other: number; bankAccountId: string; notes?: string | null;
  pfWage?: number | null; arrears?: number;
}

export interface BulkPlanRow {
  employeeId: string;
  name: string;
  draft: SalaryDraft | null;
  /** null = will be paid; else why this person is left out. */
  skip: string | null;
  input: BulkPayInput | null;
}

/** Why this employee cannot be paid in a bulk run (null = fine). Order = what the owner fixes first. */
export function bulkSkipReason(i: {
  employee: DraftEmployee; alreadyRun: boolean; draft: SalaryDraft | null; bankAccountId: string | null;
}): string | null {
  if (i.alreadyRun) return "Salary already run for this month";
  if (!i.employee.is_active && !i.employee.exit_date) return "Not an active employee";
  if (!i.draft || i.draft.monthGross <= 0 || i.draft.gross <= 0) return "No monthly salary set — use Set salary first";
  if (!i.bankAccountId) return "No bank account chosen";
  if (i.draft.net <= 0) return "Net pay is not above ₹0";
  return null;
}

export function bulkPayInput(draft: SalaryDraft, employeeId: string, payDate: string, bankAccountId: string): BulkPayInput {
  return {
    employeeId, period: draft.period, payDate, gross: draft.gross,
    lopDays: draft.lopDays, lopAmount: draft.lopAmount, incentive: 0,
    advanceRecovered: 0, advanceLoanId: null,
    tds: draft.tds, pf: draft.pf, esi: draft.esi, esiEmployer: draft.esiEmployer, pfEmployer: draft.pfEmployer,
    other: 0, bankAccountId, pfWage: draft.pfWage, arrears: draft.arrears,
  };
}

export function bulkTotal(rows: readonly BulkPlanRow[]): { count: number; net: number } {
  const pay = rows.filter((r) => !r.skip && r.draft);
  return { count: pay.length, net: pay.reduce((s, r) => s + (r.draft?.net ?? 0), 0) };
}

export interface BulkRunResult {
  paid: string[];
  /** Left out because the fresh read showed them already run (retry after a stop, another tab). */
  alreadyRun: string[];
  failed: { employeeId: string; message: string } | null;
  /** Never tried because an earlier one failed. */
  notRun: string[];
}

/** Book the rows one by one, in order. The first failure stops the run — nobody after it is touched. */
export async function runBulkPay(i: {
  rows: readonly BulkPlanRow[];
  /** Fresh read, called right before EACH booking — employee ids that already have a salary row this month. */
  readRunIds: () => Promise<ReadonlySet<string>>;
  pay: (input: BulkPayInput) => Promise<unknown>;
  onProgress?: (done: number, total: number) => void;
}): Promise<BulkRunResult> {
  const todo = i.rows.filter((r) => !r.skip && r.input);
  const out: BulkRunResult = { paid: [], alreadyRun: [], failed: null, notRun: [] };
  for (let n = 0; n < todo.length; n++) {
    const row = todo[n];
    try {
      const already = await i.readRunIds();
      if (already.has(row.employeeId)) { out.alreadyRun.push(row.employeeId); i.onProgress?.(n + 1, todo.length); continue; }
      await i.pay(row.input!);
      out.paid.push(row.employeeId);
      i.onProgress?.(n + 1, todo.length);
    } catch (e) {
      out.failed = { employeeId: row.employeeId, message: e instanceof Error ? e.message : String(e) };
      out.notRun = todo.slice(n + 1).map((r) => r.employeeId);
      return out;
    }
  }
  return out;
}
