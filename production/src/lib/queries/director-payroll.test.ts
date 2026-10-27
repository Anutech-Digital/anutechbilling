/**
 * R-1852 — which payroll expense rows are a director's: by salary_payments.expense_id, never by name.
 */
import { describe, it, expect } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";
import { fetchDirectorPayroll } from "./director-payroll";

describe("fetchDirectorPayroll", () => {
  it("returns only the linked employee's Salaries rows", async () => {
    const db = fakePostgrest({
      company_directors: [{ id: "d1", employee_id: "e1" }, { id: "d2", employee_id: null }],
      salary_payments: [{ id: "s1", employee_id: "e1", expense_id: "X1" }, { id: "s2", employee_id: "e2", expense_id: "X2" }],
      expenses: [
        { id: "X1", vendor_name: "Asha Verma", expense_date: "2026-10-31", amount: 150000, category: "Salaries" },
        { id: "X2", vendor_name: "Asha Verma", expense_date: "2026-10-31", amount: 40000, category: "Salaries" }, // same name, other employee
      ],
    });
    expect(await fetchDirectorPayroll(db.client)).toEqual([
      { id: "X1", vendor_name: "Asha Verma", expense_date: "2026-10-31", amount: 150000 },
    ]);
  });

  it("before the migration (no employee_id column) → [] ; any other failed read throws", async () => {
    const failing = (code: string, message: string) => ({
      from: () => ({ select: () => Promise.resolve({ data: null, error: { code, message } }) }),
    });
    expect(await fetchDirectorPayroll(failing("42703", "column company_directors.employee_id does not exist"))).toEqual([]);
    await expect(fetchDirectorPayroll(failing("57014", "canceling statement due to statement timeout"))).rejects.toThrow(/timeout/);
  });
});
