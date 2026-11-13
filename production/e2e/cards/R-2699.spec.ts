/**
 * Card test — R-2699 "Salary revision / increment with an effective-from month and history".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2699`.
 *
 * Data (planted here, local docker DB only, fixed ids):
 *  - "Card R2699 Raise": ₹30,000 a month (Basic ₹15,000), PF / ESI off, nothing booked.
 *  - "Card R2699 Paid":  ₹30,000 a month, PF / ESI off, Sep 2026 already booked at ₹30,000 (booked 30 Sep).
 * Months are fixed past months (Sep / Oct 2026) so "full month" holds whatever today is. All removed after.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, localDb, onlyInCardTests, openAppPage, pageAs, onlyOne, E2E_TENANT_SQL } from "./card-steps";

const RAISE_ID = "c2699000-0000-4000-8000-000000000001";
const PAID_ID = "c2699000-0000-4000-8000-000000000002";
const SAL_SEP = "c2699000-0000-4000-8000-000000000011";
const RAISE = "Card R2699 Raise";
const PAID = "Card R2699 Paid";

const psql = (sql: string): string[] => localDb("R-2699").psql(sql);

function unplant(): void {
  psql(`
begin;
with gone as (delete from public.salary_payments where employee_id in ('${RAISE_ID}', '${PAID_ID}') returning expense_id)
delete from public.expenses where id in (select expense_id from gone where expense_id is not null);
delete from public.employee_salary_revisions where employee_id in ('${RAISE_ID}', '${PAID_ID}');
delete from public.employees where id in ('${RAISE_ID}', '${PAID_ID}');
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date, is_active, pf_applicable, esi_applicable)
select '${RAISE_ID}', ${E2E_TENANT_SQL}, '${RAISE}', 30000, 15000, '2026-01-01', true, false, false;
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date, is_active, pf_applicable, esi_applicable)
select '${PAID_ID}', ${E2E_TENANT_SQL}, '${PAID}', 30000, 15000, '2026-01-01', true, false, false;
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net, paid_status, paid_amount, notes, created_at)
select '${SAL_SEP}', ${E2E_TENANT_SQL}, '${PAID_ID}', '2026-09', '2026-09-30', 30000, 30000, 'unpaid', 0, 'R-2699 card test', '2026-09-30T10:00:00Z';
commit;`);
}

async function openProfile(page: Page, name: string): Promise<void> {
  await openAppPage(page, "/accounting/employees", /^Employees$/);
  const open = page.locator("table").getByRole("button", { name: `Open ${name}'s profile` });
  await expect(open).toBeVisible({ timeout: 60_000 });
  await open.click();
}

async function revise(page: Page, name: string, month: string, gross: string): Promise<void> {
  await openProfile(page, name);
  const section = await onlyOne(page.getByRole("dialog").getByTestId("salary-revisions"), "Salary revisions");
  await section.getByRole("button", { name: "Revise salary" }).click();
  const dlg = page.getByRole("dialog", { name: `Revise salary — ${name}` });
  await expect(dlg.locator("#revise-effective")).not.toHaveValue("", { timeout: 60_000 });
  await dlg.locator("#revise-effective").fill(month);
  await dlg.locator("#revise-gross").fill(gross);
  await expect(dlg.getByTestId("revise-breakdown")).toContainText(`₹30,000 → ₹${Number(gross).toLocaleString("en-IN")} a month`);
}

async function openPayroll(page: Page, month: string): Promise<void> {
  await openAppPage(page, "/accounting/payroll", /^Payroll$/);
  await page.locator("#payroll-month").fill(month);
}

function payrollRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

test.describe("R-2699 — salary revision from a month; earlier months keep the old salary; arrears", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) unplant(); });

  test("Step 1: Employees → Card R2699 Raise → Revise salary ₹36,000 from Oct 2026 → history shows ₹30,000 → ₹36,000", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await revise(page, RAISE, "2026-10", "36000");
      const dlg = page.getByRole("dialog", { name: `Revise salary — ${RAISE}` });
      await expect(dlg.locator("#revise-basic")).toHaveValue("18000");
      await dlg.getByRole("button", { name: "Save revision from October 2026" }).click();
      const section = page.getByRole("dialog").getByTestId("salary-revisions");
      await expect(section).toContainText("From October 2026: ₹30,000 → ₹36,000/month", { timeout: 60_000 });
      expect(psql(`select monthly_gross || '/' || basic_monthly from public.employees where id = '${RAISE_ID}';`)[0]).toBe("36000/18000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Payroll Sep 2026 → ₹30,000 (old); Oct 2026 → ₹36,000 (new) — in the table and in Pay salary", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openPayroll(page, "2026-09");
      await expect(payrollRow(page, RAISE)).toContainText("₹30,000", { timeout: 60_000 });
      await payrollRow(page, RAISE).getByRole("button", { name: "Pay salary" }).click();
      let dlg = page.getByRole("dialog", { name: `Pay salary — ${RAISE}` });
      await expect(dlg.locator("#payroll-salary-to-pay")).toHaveValue("30000", { timeout: 60_000 });
      await expect(dlg.getByTestId("pay-salary-in-force")).toContainText("Salary for September 2026: ₹30,000/month");
      await dlg.getByRole("button", { name: "Cancel" }).click();

      await page.locator("#payroll-month").fill("2026-10");
      await expect(payrollRow(page, RAISE)).toContainText("₹36,000", { timeout: 60_000 });
      await payrollRow(page, RAISE).getByRole("button", { name: "Pay salary" }).click();
      dlg = page.getByRole("dialog", { name: `Pay salary — ${RAISE}` });
      await expect(dlg.locator("#payroll-salary-to-pay")).toHaveValue("36000", { timeout: 60_000 });
      await expect(dlg.getByTestId("pay-salary-in-force")).toContainText("Revised from October 2026: ₹30,000 → ₹36,000/month");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Card R2699 Paid (Sep booked) → revise ₹36,000 from Sep → Pay Oct offers arrears ₹6,000 → booked once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await revise(page, PAID, "2026-09", "36000");
      const rdlg = page.getByRole("dialog", { name: `Revise salary — ${PAID}` });
      // R-2722: booked (not paid — no bank line linked); this planted row has no salary_in_force (booked before revisions).
      await expect(rdlg).toContainText("September 2026 is already booked at the old salary");
      await expect(rdlg.getByTestId("revise-legacy-months")).toHaveText("September 2026 was booked before salary revisions — check the old salary used for it.");
      await expect(rdlg).toContainText("₹6,000");
      await rdlg.getByRole("button", { name: "Save revision from September 2026" }).click();
      await expect(page.getByRole("dialog").getByTestId("salary-revisions")).toContainText("From September 2026", { timeout: 60_000 });
      expect(psql(`select gross || '/' || net from public.salary_payments where id = '${SAL_SEP}';`)[0]).toBe("30000/30000");

      await openPayroll(page, "2026-10");
      await payrollRow(page, PAID).getByRole("button", { name: "Pay salary" }).click({ timeout: 60_000 });
      const dlg = page.getByRole("dialog", { name: `Pay salary — ${PAID}` });
      const arrears = dlg.getByTestId("pay-salary-arrears");
      await expect(arrears).toContainText("Due ₹6,000 for Sep 2026", { timeout: 60_000 });
      await expect(dlg.locator("#payroll-arrears")).toHaveValue("6000");
      await expect(dlg).toContainText("+ Salary revision arrears");
      await dlg.locator("#payroll-tds").fill("0");
      await dlg.getByRole("button", { name: /^Pay ₹/ }).click();
      await expect.poll(() => psql(`select gross || '/' || arrears || '/' || incentive || '/' || net from public.salary_payments where employee_id = '${PAID_ID}' and period = '2026-10';`)[0], { timeout: 60_000 })
        .toBe("36000/6000/6000/42000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: the latest revision with nothing booked on it can be undone → back to ₹30,000", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openProfile(page, RAISE);
      const section = await onlyOne(page.getByRole("dialog").getByTestId("salary-revisions"), "Salary revisions");
      await section.getByRole("button", { name: "Undo" }).click({ timeout: 60_000 });
      await page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Undo the salary revision/ })).getByRole("button", { name: "Undo revision" }).click();
      await expect.poll(() => psql(`select monthly_gross from public.employees where id = '${RAISE_ID}';`)[0], { timeout: 60_000 }).toBe("30000");
      await expect(section).toContainText("No revisions yet", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });
});
