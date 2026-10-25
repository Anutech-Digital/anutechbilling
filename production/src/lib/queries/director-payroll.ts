/**
 * R-1852 — the payroll expense rows of employees who are directors (company_directors.employee_id,
 * migration 20261025003000). The P&L moves them from Salaries to Director's Remuneration
 * (lib/accounting/director-remuneration.ts); the P&L drill-down lists them under that line.
 *
 * Found by id — salary_payments.expense_id — never by name. A role that cannot read the register
 * or salaries (RLS, R-1001) reads no rows → [] → the Salaries line as before. Before the migration
 * (no employee_id column / no table) → [] too. Any OTHER failed read throws, so the P&L shows its
 * error + Try again instead of a quietly different split (R-1655).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { DirectorPayrollExpense } from "@/lib/accounting/director-remuneration";

export interface DirectorPayrollRow extends DirectorPayrollExpense { id: string }

/** "column company_directors.employee_id does not exist" / "relation … does not exist" — not migrated. */
function notMigrated(err: { code?: string | null; message?: string | null }): boolean {
  return err.code === "42703" || err.code === "42P01" || err.code === "PGRST204" || err.code === "PGRST205"
    || /(employee_id|company_directors).*(does not exist|could not find|schema cache)/i.test(err.message ?? "");
}

export async function fetchDirectorPayroll(client: unknown): Promise<DirectorPayrollRow[]> {
  const supabase = client as SupabaseClient;
  /* The register is a handful of rows: read the column and keep the linked ones here. */
  const dirs = await supabase.from("company_directors").select("employee_id");
  if (dirs.error) {
    if (notMigrated(dirs.error)) return [];
    throw new Error(dirs.error.message);
  }
  const employeeIds = [...new Set(((dirs.data ?? []) as { employee_id: string | null }[])
    .map((d) => d.employee_id).filter((x): x is string => !!x))];
  if (employeeIds.length === 0) return [];
  const pays = (await fetchAllRowsIn(employeeIds, (ids, a, b) =>
    supabase.from("salary_payments").select("id, expense_id").in("employee_id", ids).order("id").range(a, b) as never,
  )) as { id: string; expense_id: string | null }[];
  const expenseIds = [...new Set(pays.map((p) => p.expense_id).filter((x): x is string => !!x))];
  if (expenseIds.length === 0) return [];
  const rows = (await fetchAllRowsIn(expenseIds, (ids, a, b) =>
    supabase.from("expenses").select("id, vendor_name, expense_date, amount, category").in("id", ids).order("id").range(a, b) as never,
  )) as { id: string; vendor_name: string | null; expense_date: string; amount: number; category: string | null }[];
  /* Only rows Payroll booked as Salaries move — anything re-categorised by hand stays where it is. */
  return rows
    .filter((r) => r.category === "Salaries")
    .map((r) => ({ id: r.id, vendor_name: r.vendor_name, expense_date: r.expense_date, amount: Number(r.amount) || 0 }));
}
