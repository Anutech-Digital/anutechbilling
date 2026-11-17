/**
 * R-2911 (17 Nov 2026) — corrects R-2681's salary part. A Zoho salary comes in as Salaries unless Payroll
 * already books it. The preview says what the SQL import says
 * (supabase/tests/r2911_zoho_salary_vs_payroll.test.sql — the same sentences, the same cases).
 */
import { describe, it, expect } from "vitest";
import { buildPurchasePlan, type PurchasePlanContext } from "./plan";
import type { PurchaseFacts } from "./normalise";
import {
  NO_PAYROLL, SALARY_BILL_REASON, SALARY_FROM_ZOHO_NOTE, SALARY_TDS_REASON, employeesNamed, isSalaryAccount, notAnExpenseReason,
  payslipCovers, salaryPayrollRefusal, type PayrollFacts,
} from "./account-types";

const line = (over: Partial<PurchaseFacts["lines"][number]> = {}) => ({
  accountId: "A-SAL", accountName: "Salaries and wages", description: "", hsn: "", qty: 1, taxable: 17000, tax: 0, itcEligible: true, ...over,
});
function doc(over: Partial<PurchaseFacts> = {}): PurchaseFacts {
  return {
    kind: "expenses", zohoId: "s1", number: "", date: "2025-04-30", dueDate: null, status: "nonbillable",
    vendorZohoId: "VZ-P", vendorName: "Emp Prashant ( Salary )", gstin: "", gstTreatment: "", currency: "INR",
    taxable: 17000, igst: 0, cgst: 0, sgst: 0, tax: 0, total: 17000, rcm: false, rcmTax: 0, tdsAmount: 0, tdsSection: null,
    lines: [line()], paidThrough: "HDFC 4523", reference: "", problems: [], ...over,
  };
}
/* As on staging: Prashant's first payslip is Jun 2026. Ravi Kumar: May 2025 paid 3 Jun 2025. Director
   Anil: Aug 2025 paid 31 Aug 2025. */
const payroll: PayrollFacts = {
  employees: [{ id: "c1", name: "Prashant" }, { id: "c2", name: "Ravi Kumar" }, { id: "c3", name: "Anil Sharma" }],
  payslips: [
    { employeeId: "c1", period: "2026-06", payDate: "2026-07-03" },
    { employeeId: "c2", period: "2025-05", payDate: "2025-06-03" },
    { employeeId: "c3", period: "2025-08", payDate: "2025-08-31" },
  ],
};
const ctx = (over: Partial<PurchasePlanContext> = {}): PurchasePlanContext => ({
  fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
  vendors: [],
  categoryMap: { "A-RENT": "Office Rent", "A-DIR": "Director's Remuneration" },
  imported: new Set<string>(),
  bankAccounts: [{ id: "acc-4523", name: "HDFC Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true, is_default_petty_cash: false }],
  accountMap: {},
  accountTypes: { "A-RENT": "expense", "A-SAL": "expense", "A-SADV": "other_current_asset", "A-UNMAP": "other_expense", "A-DIR": "expense", "A-SEW": "expense" },
  payroll,
  ...over,
});
const one = (f: PurchaseFacts, c = ctx()) => buildPurchasePlan([f], c).rows[0];
const RAVI_MAY = "Payroll already books this salary — Ravi Kumar's payslip for May 2025 (paid 03 Jun 2025) is in Payroll, so this Zoho salary is not imported (it would count twice). If it is a different payment, add it by hand.";

describe("R-2911 a Zoho salary vs Payroll (owner, 17 Nov: 'jo logically thik ho wo kro')", () => {
  it("S1 Prashant Apr 2025 — his only payslip is Jun 2026 → imported as Salaries, with the preview's note", () => {
    const r = one(doc());
    expect(r).toMatchObject({ verdict: "import", target: "expense", salaryNote: SALARY_FROM_ZOHO_NOTE });
    expect(r.legs.map((l) => l.category)).toEqual(["Salaries"]);
    const p = buildPurchasePlan([doc()], ctx());
    expect(p.counts.salaryFromZoho).toBe(1);
    expect(p.unmapped).toEqual([]); // a salary account is not "not mapped"
  });

  it("S2 the employee's payslip for that month → refused; S2b last month's payslip paid within 7 days → refused", () => {
    expect(one(doc({ zohoId: "s2", date: "2025-05-31", vendorName: "Ravi Kumar", vendorZohoId: "VZ-R" }))).toMatchObject({ verdict: "skip", reason: RAVI_MAY, salaryNote: null });
    expect(one(doc({ zohoId: "s2b", date: "2025-06-04", vendorName: "Staff Payouts", vendorZohoId: "VZ-S", lines: [line({ description: "salary to Ravi" })] })).reason).toBe(RAVI_MAY);
  });

  it("S2c Ravi's JUNE salary in Zoho (30 Jun) is not covered by May's payslip paid 3 Jun → imported", () => {
    expect(one(doc({ zohoId: "s2c", date: "2025-06-30", vendorName: "Ravi Kumar", vendorZohoId: "VZ-R" })).verdict).toBe("import");
  });

  it("S3 the named employee has no payslip that month (another employee has) → imported", () => {
    expect(one(doc({ zohoId: "s3", date: "2025-05-30" })).verdict).toBe("import");
  });

  it("S4 payee not an employee: refused when a payslip covers the date, imported when none does", () => {
    expect(one(doc({ zohoId: "s4", date: "2025-05-28", vendorName: "Mohan Lal", vendorZohoId: "VZ-M" })).reason)
      .toBe("Payroll has salaries for May 2025 and Zoho's payee is not an employee in Payroll — add it by hand if it is someone else (it could count twice).");
    expect(one(doc({ zohoId: "s4b", date: "2025-07-31", vendorName: "Mohan Lal", vendorZohoId: "VZ-M" })).verdict).toBe("import");
  });

  it("S5 a salary-named account that is not an expense type stays 'Not an expense' (type rule first, new wording)", () => {
    const r = one(doc({ zohoId: "s5", lines: [line({ accountId: "A-SADV", accountName: "Salary advance" })] }));
    expect(r.reason).toBe('Not an expense — needs another path: in Zoho, "Salary advance" is an account of type "other current asset". Fixed deposits, loans, GST, assets and advances are never booked as an expense.');
    expect(r.reason).toBe(notAnExpenseReason("Salary advance", "other_current_asset"));
  });

  it("S6 no vendor in Zoho → imported vendor-less as Salaries", () => {
    const r = one(doc({ zohoId: "s6", date: "2025-08-31", vendorName: "", vendorZohoId: "", lines: [line({ description: "Salary Prashant Aug" })] }));
    expect(r).toMatchObject({ verdict: "import", noVendor: true, salaryNote: SALARY_FROM_ZOHO_NOTE });
  });

  it("S7 a salary line + an unmapped non-salary line → the whole document left out ('not mapped')", () => {
    expect(one(doc({ zohoId: "s7", lines: [line(), line({ accountId: "A-UNMAP", accountName: "Misc charges", taxable: 600 })] })).reason)
      .toBe('Zoho account "Misc charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.');
  });

  it("S8 a Zoho salary BILL stays out (no pay path for an unpaid Salaries row); S9 a salary with TDS stays out (192 is Payroll's)", () => {
    expect(one(doc({ kind: "bills", zohoId: "b1", number: "SAL-1", status: "open" }))).toMatchObject({ verdict: "skip", reason: SALARY_BILL_REASON });
    expect(one(doc({ zohoId: "s9", tdsAmount: 1700, tdsSection: "192" }))).toMatchObject({ verdict: "skip", reason: SALARY_TDS_REASON });
  });

  it("S10 a salary account MAPPED by the owner (Director Salary → Director's Remuneration) is still checked against Payroll", () => {
    const dir = (date: string) => doc({ zohoId: `d-${date}`, date, vendorName: "Anil Sharma", vendorZohoId: "VZ-A", lines: [line({ accountId: "A-DIR", accountName: "Director Salary" })] });
    expect(one(dir("2025-08-31")).reason).toMatch(/^Payroll already books this salary — Anil Sharma's payslip for Aug 2025 \(paid 31 Aug 2025\)/);
    const ok = one(dir("2025-10-31"));
    expect(ok).toMatchObject({ verdict: "import", salaryNote: null });
    expect(ok.legs.map((l) => l.category)).toEqual(["Director's Remuneration"]);
  });

  it("S11 'Sewage charges' / 'Payroll processing fees' are not salaries — unmapped, left out as before", () => {
    expect(one(doc({ zohoId: "s11", lines: [line({ accountId: "A-SEW", accountName: "Sewage charges" })] })).reason)
      .toBe('Zoho account "Sewage charges" is not mapped — left out for now (owner, 17 Nov). Map it only if it is an expense.');
    expect(["Salaries and Employee Wages", "Salary", "Wages", "Staff wage"].map(isSalaryAccount)).toEqual([true, true, true, true]);
    expect(["Sewage charges", "Payroll processing fees", "Wagestone Ltd", "Basicsalary"].map(isSalaryAccount)).toEqual([false, false, false, false]);
  });

  it("no Payroll at all (FY 2025-26 on Excel) → every salary comes in; a context without payroll counts as none", () => {
    expect(one(doc({ date: "2025-05-31", vendorName: "Ravi Kumar" }), ctx({ payroll: NO_PAYROLL })).verdict).toBe("import");
    expect(one(doc(), ctx({ payroll: undefined })).verdict).toBe("import");
  });

  it("a rerun stays 'already'", () => {
    expect(one(doc(), ctx({ imported: new Set(["expenses:s1"]) })).verdict).toBe("already");
  });
});

describe("R-2911 naming an employee, and which payslip covers a date", () => {
  const emps = [{ id: "a", name: "Ravi Kumar" }, { id: "b", name: "Prashant" }, { id: "c", name: "Om" }, { id: "d", name: "Raj" }];
  it("whole name or first word (3+ letters), as whole words, case and punctuation ignored, sorted by name", () => {
    expect(employeesNamed("Emp PRASHANT (Salary)", emps).map((e) => e.id)).toEqual(["b"]);
    expect(employeesNamed("ravi-kumar oct", emps).map((e) => e.id)).toEqual(["a"]);
    expect(employeesNamed("Ravi", emps).map((e) => e.id)).toEqual(["a"]);
    expect(employeesNamed("Rajesh", emps)).toEqual([]); // "Raj" is not a whole word of "Rajesh"
    expect(employeesNamed("Raj and Ravi", emps).map((e) => e.id)).toEqual(["d", "a"]);
    expect(employeesNamed("Om", emps).map((e) => e.id)).toEqual(["c"]); // whole name, though shorter than 3
    expect(employeesNamed("Om Prakash", [{ id: "x", name: "Om Prakash Gupta" }])).toEqual([]); // first word "om" too short
  });
  it("covers: same month; or last month paid within 7 days (also across a year end)", () => {
    const slip = (period: string, payDate: string) => ({ employeeId: "e", period, payDate });
    expect(payslipCovers(slip("2025-05", "2025-06-03"), "2025-05-31")).toBe(true);
    expect(payslipCovers(slip("2025-05", "2025-06-03"), "2025-06-10")).toBe(true);
    expect(payslipCovers(slip("2025-05", "2025-06-03"), "2025-06-11")).toBe(false);
    expect(payslipCovers(slip("2026-06", "2026-06-30"), "2026-07-01")).toBe(true); // paid 30 Jun, Zoho 1 Jul
    expect(payslipCovers(slip("2025-12", "2026-01-02"), "2026-01-05")).toBe(true);
    expect(payslipCovers(slip("2025-07", "2025-08-01"), "2025-06-30")).toBe(false);
    expect(salaryPayrollRefusal("Ravi Kumar", "2025-05-31", payroll)).toBe(RAVI_MAY);
  });
});
