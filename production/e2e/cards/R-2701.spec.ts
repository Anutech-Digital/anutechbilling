/**
 * Card test — R-2701 "Employee profile shows booked salary months; the delete refusal names them + offers Start exit".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2701`.
 *
 * Data (planted here, local docker DB only, fixed ids): employee "Card R2701 Booked" with salary booked for
 * Aug 2026 (₹30,000 gross, ₹1,800 PF, net ₹28,200) and Sep 2026 (₹30,000 + ₹2,000 bonus, ₹1,000 LOP, ₹1,800 PF,
 * net ₹29,200), and employee "Card R2701 Fresh" with no salary. All removed after the last step.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, localDb, onlyInCardTests, openAppPage, pageAs, onlyOne } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const BOOKED_ID = "c2701000-0000-4000-8000-000000000001";
const FRESH_ID = "c2701000-0000-4000-8000-000000000002";
const SAL_AUG = "c2701000-0000-4000-8000-000000000011";
const SAL_SEP = "c2701000-0000-4000-8000-000000000012";
const BOOKED = "Card R2701 Booked";
const FRESH = "Card R2701 Fresh";

const psql = (sql: string): string[] => localDb("R-2701").psql(sql);

function unplant(): void {
  psql(`
begin;
delete from public.salary_payments where id in ('${SAL_AUG}', '${SAL_SEP}');
delete from public.employees where id in ('${BOOKED_ID}', '${FRESH_ID}');
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.employees (id, tenant_id, name, monthly_gross, joining_date, is_active)
select '${BOOKED_ID}', t.id, '${BOOKED}', 30000, '2026-01-01', true from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.employees (id, tenant_id, name, monthly_gross, joining_date, is_active)
select '${FRESH_ID}', t.id, '${FRESH}', 20000, '2026-10-01', true from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, pf, net, paid_status, paid_amount, notes)
select '${SAL_AUG}', t.id, '${BOOKED_ID}', '2026-08', '2026-08-31', 30000, 1800, 28200, 'unpaid', 0, 'R-2701 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.salary_payments (id, tenant_id, employee_id, period, pay_date, gross, incentive, lop_amount, pf, net, paid_status, paid_amount, notes)
select '${SAL_SEP}', t.id, '${BOOKED_ID}', '2026-09', '2026-09-30', 30000, 2000, 1000, 1800, 29200, 'unpaid', 0, 'R-2701 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;`);
}

async function openEmployees(page: Page): Promise<void> {
  await openAppPage(page, "/accounting/employees", /^Employees$/);
  await expect(page.getByRole("button", { name: `Open ${BOOKED}'s profile` }).first()).toBeVisible({ timeout: 60_000 });
}

async function openRowMenuDelete(page: Page, name: string): Promise<void> {
  const menu = page.locator("table").getByRole("button", { name: `Actions for ${name}` });
  await expect(menu).toBeVisible({ timeout: 60_000 });
  await menu.click();
  // The owner's role loads after the list — "Start exit" (or "Cancel exit") in the menu proves it is in (as R-2698's spec).
  await expect(page.getByRole("menuitem", { name: /^(Start exit|Cancel exit)$/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Delete employee" }).click();
}

test.describe("R-2701 — employee salary months on the profile; delete refusal names them", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) unplant(); });

  test("Step 1: Employees → open Card R2701 Booked → Salary & payments lists Sep 2026 and Aug 2026 with gross, deductions, net", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      await page.locator("table").getByRole("button", { name: `Open ${BOOKED}'s profile` }).click();
      const section = await onlyOne(page.getByRole("dialog").getByTestId("employee-salary-payments"), "Salary & payments");
      const rows = section.getByTestId("salary-month-row");
      await expect(rows).toHaveCount(2, { timeout: 60_000 });
      await expect(rows.nth(0)).toContainText("Sep 2026");
      await expect(rows.nth(0)).toContainText("₹29,200");
      await expect(rows.nth(0)).toContainText("Gross ₹32,000 − deductions ₹2,800");
      await expect(rows.nth(0)).toContainText("Not paid yet");
      await expect(rows.nth(1)).toContainText("Aug 2026");
      await expect(rows.nth(1)).toContainText("₹28,200");
      await expect(section.getByRole("link", { name: "Full salary register" })).toHaveAttribute("href", `/accounting/salary-register?employee=${BOOKED_ID}`);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: ⋯ → Delete employee → says it can't be deleted, names Aug 2026, Sep 2026, offers Start exit; no Delete button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      await openRowMenuDelete(page, BOOKED);
      const dialog = page.getByRole("dialog", { name: `${BOOKED} can't be deleted` });
      await expect(dialog).toContainText("salary booked for Aug 2026, Sep 2026", { timeout: 60_000 });
      await expect(dialog.getByRole("button", { name: "Start exit" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Delete employee" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "See salary months" }).click();
      await expect(page.getByRole("dialog").getByTestId("salary-month-row")).toHaveCount(2, { timeout: 60_000 });
      expect(psql(`select count(*) from public.employees where id = '${BOOKED_ID}';`)[0]).toBe("1");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Start exit from the refusal opens the existing Start exit dialog", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      await openRowMenuDelete(page, BOOKED);
      const dialog = page.getByRole("dialog", { name: `${BOOKED} can't be deleted` });
      await dialog.getByRole("button", { name: "Start exit" }).click({ timeout: 60_000 });
      await expect(page.getByRole("dialog", { name: `Start exit — ${BOOKED}` })).toBeVisible({ timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: an employee with no salary → plain Delete confirm → Delete employee removes them", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      await openRowMenuDelete(page, FRESH);
      const dialog = page.getByRole("dialog", { name: `Delete ${FRESH}?` });
      await dialog.getByRole("button", { name: "Delete employee" }).click({ timeout: 60_000 });
      await expect.poll(() => psql(`select count(*) from public.employees where id = '${FRESH_ID}';`)[0], { timeout: 60_000 }).toBe("0");
    } finally {
      await page.context().close();
    }
  });
});
