/**
 * Card test — R-2771 "Salary Register: change a month's salary right from the register row".
 * Hitesh (staging, 14 Nov): "I want to edit the salary of a specific month directly from here".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2771`.
 *
 * Data (local docker DB only, fixed ids, removed after): "CT R2771 Asha" — ₹30,000 a month, PF / ESI off.
 *  • Sep 2026 booked, not linked to a bank line (gross 30,000, net 30,000) → editable.
 *  • Aug 2026 booked and paid by a planted bank line → locked, links to that line.
 * Step 2 saves an edit — on this planted test employee only (local DB), never real data.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const EMP = "c2771000-0000-4000-8000-000000000001";
const SAL_SEP = "c2771000-0000-4000-8000-000000000011";
const SAL_AUG = "c2771000-0000-4000-8000-000000000012";
const TXN_AUG = "c2771000-0000-4000-8000-000000000021";
const NAME = "CT R2771 Asha";
const ACCT_SQL = `(select a.id from public.bank_accounts a where a.tenant_id = ${E2E_TENANT_SQL} and a.is_active and a.account_type not in ('cash', 'credit_card') order by a.created_at, a.id limit 1)`;

const psql = (sql: string): string[] => localDb("R-2771").psql(sql);

function unplant(): void {
  psql(`
begin;
delete from public.bank_transactions where id = '${TXN_AUG}';
with gone as (delete from public.salary_payments where employee_id = '${EMP}' returning expense_id)
delete from public.expenses where id in (select expense_id from gone where expense_id is not null);
delete from public.employees where id = '${EMP}';
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date, is_active, pf_applicable, esi_applicable)
select '${EMP}', ${E2E_TENANT_SQL}, '${NAME}', 30000, 15000, '2026-01-01', true, false, false;
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net, paid_status, paid_amount, bank_account_id, notes)
select '${SAL_SEP}', ${E2E_TENANT_SQL}, '${EMP}', '2026-09', '2026-09-30', 30000, 30000, 'unpaid', 0, ${ACCT_SQL}, 'R-2771 card test';
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, net, paid_status, paid_amount, bank_account_id, notes)
select '${SAL_AUG}', ${E2E_TENANT_SQL}, '${EMP}', '2026-08', '2026-08-31', 30000, 30000, 'unpaid', 0, ${ACCT_SQL}, 'R-2771 card test';
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source, matched_to_type, matched_to_id)
select '${TXN_AUG}', ${E2E_TENANT_SQL}, ${ACCT_SQL}, '2026-08-31', 'NEFT DR CT R2771 ASHA SALARY AUG', 30000, 0, 'CT-R2771-AUG', 'csv_upload', 'salary', '${SAL_AUG}';
update public.salary_payments set paid_amount = 30000, paid_status = 'paid', reconciled_txn_id = '${TXN_AUG}' where id = '${SAL_AUG}';
commit;`);
}

async function openRegisterFromProfile(page: Page): Promise<void> {
  await openAppPage(page, "/accounting/employees", /^Employees$/);
  const open = page.locator("table").getByRole("button", { name: `Open ${NAME}'s profile` });
  await expect(open).toBeVisible({ timeout: 60_000 });
  await open.click();
  await page.getByRole("link", { name: "Full salary register" }).click({ timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`/accounting/salary-register\\?employee=${EMP}`), { timeout: 60_000 });
}

const row = (page: Page, month: string) => page.locator("table tbody tr").filter({ hasText: month });
const actions = (page: Page, month: string) => page.getByRole("button", { name: `Salary actions for ${NAME}, ${month}` });

test.describe("R-2771 — edit a month's salary from the Salary Register", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) unplant(); });

  test("Step 1: profile → Full salary register → every booked month has ⋯ with Edit salary / Undo salary; fits 1280 px", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openRegisterFromProfile(page);
      await expect(row(page, "Sep 2026")).toContainText("₹30,000", { timeout: 60_000 });
      // UI rule: the register with its new ⋯ column still fits 1280 px — no sideways scroll.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await (await onlyOne(actions(page, "September 2026"), "Sep ⋯")).click();
      await expect(page.getByRole("menuitem", { name: "Edit salary", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Undo salary" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(actions(page, "August 2026")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Sep 2026 → Edit salary → form on the same page with the booked salary → Gross +1,000 → Save → row + total update in place", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openRegisterFromProfile(page);
      await (await onlyOne(actions(page, "September 2026"), "Sep ⋯")).click();
      await page.getByRole("menuitem", { name: "Edit salary", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: `Edit salary — ${NAME}` });
      await expect(dlg.locator("#payroll-salary-to-pay")).toHaveValue("30000", { timeout: 60_000 });
      await expect(dlg.locator("#payroll-pay-date")).toHaveValue("2026-09-30");
      // Cancel first: nothing changes (the old Payroll Edit undid the salary before the form opened).
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(psql(`select gross || '/' || net from public.salary_payments where employee_id = '${EMP}' and period = '2026-09';`)[0]).toBe("30000/30000");
      expect(page.url()).toContain(`employee=${EMP}`);

      await (await onlyOne(actions(page, "September 2026"), "Sep ⋯")).click();
      await page.getByRole("menuitem", { name: "Edit salary", exact: true }).click();
      await expect(dlg.locator("#payroll-salary-to-pay")).toHaveValue("30000", { timeout: 60_000 });
      await dlg.locator("#payroll-salary-to-pay").fill("31000");
      await expect(dlg.locator("#payroll-tds")).toHaveValue("0");
      await dlg.getByRole("button", { name: /^Save ₹31,000/ }).click();
      await expect(dlg).toBeHidden({ timeout: 60_000 });
      await expect.poll(() => psql(`select gross || '/' || net from public.salary_payments where employee_id = '${EMP}' and period = '2026-09';`)[0], { timeout: 60_000 })
        .toBe("31000/31000");
      expect(page.url()).toContain(`employee=${EMP}`);
      await expect(row(page, "Sep 2026")).toContainText("₹31,000", { timeout: 60_000 });
      await expect(page.locator("table tbody tr").filter({ hasText: "2 months" })).toContainText("₹61,000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Aug 2026 (paid by a bank line) → no Edit; says un-link first + link to that bank line", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openRegisterFromProfile(page);
      await (await onlyOne(actions(page, "August 2026"), "Aug ⋯")).click();
      await expect(page.getByRole("menuitem", { name: "Edit salary", exact: true })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: /Linked to a bank line — un-link it first to edit/ })).toBeVisible();
      const link = page.getByRole("menuitem", { name: /Open bank line/ });
      await expect(link).toHaveAttribute("href", new RegExp(`\\?txn=${TXN_AUG}$`));
    } finally {
      await page.context().close();
    }
  });
});
