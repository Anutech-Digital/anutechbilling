/**
 * Card test — R-2773 "New employee: monthly Gross → Basic 100%, company policy Basic 50% ignored"
 * (Hitesh, 14 Nov 2026, feedback 043e6753).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2773`.
 *
 * Data (local docker DB only, fixed id / fixed names, removed after):
 *   · CT R2773 New A / New B — made by the steps through Add employee;
 *   · CT R2773 Old — saved gross ₹30,000, Basic ₹15,000, PF on (Edit employee step);
 *   · the E2E Test Co payroll policy Basic % — put back to 50 after the run.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const OLD = "c2773000-0000-4000-8000-000000000001";
const OLD_NAME = "CT R2773 Old";
const NEW_NAMES = "'CT R2773 New A','CT R2773 New B'";

function clean(): void {
  localDb("R-2773").psql(`begin;
    delete from public.employees where tenant_id = ${E2E_TENANT_SQL} and (id = '${OLD}' or name in (${NEW_NAMES}));
    update public.attendance_settings set payroll_basic_pct = 50 where tenant_id = ${E2E_TENANT_SQL};
    commit;`);
}

function seed(): void {
  localDb("R-2773").psql(`insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, pf_full_wage, joining_date, is_active)
    values ('${OLD}', ${E2E_TENANT_SQL}, '${OLD_NAME}', 30000, 15000, 0, false, true, false, '2026-01-01', true);`);
}

function empRow(name: string): string {
  return localDb("R-2773").one(`select monthly_gross::text || ',' || coalesce(basic_monthly::text, 'null')
    from public.employees where tenant_id = ${E2E_TENANT_SQL} and name = '${name}'`);
}

async function addEmployeeWithGross(page: Page, name: string, gross: string) {
  await openAppPage(page, "/accounting/employees", /Employees/);
  await (await onlyOne(page.getByRole("main").getByRole("button", { name: "Add employee", exact: true }).filter({ visible: true }), "Add employee")).click();
  const dlg = page.getByRole("dialog", { name: "Add employee" });
  await expect(dlg).toBeVisible();
  await fillKept(dlg.locator("#payroll-full-name"), name);
  await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
  await fillKept(dlg.locator("#payroll-monthly-gross-salary-base"), gross);
  return dlg;
}

test.describe("R-2773 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: policy Basic 50% → Add employee, Monthly Gross 30,000 → 'Basic Salary (50%)' ₹15,000 (not 100%); Save → saved 30,000 / Basic 15,000", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await addEmployeeWithGross(page, "CT R2773 New A", "30000");
      await expect(dlg).toContainText("Basic Salary (50%):", { timeout: 30_000 });
      await expect(dlg).not.toContainText("Basic Salary (100%):");
      await expect(dlg).toContainText("₹15,000");
      await dlg.getByRole("button", { name: "Save" }).click();
      await expect(dlg).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => empRow("CT R2773 New A"), { timeout: 15_000 }).toBe("30000,15000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: policy Basic 40% → Add employee, Monthly Gross 30,000 → 'Basic Salary (40%)' ₹12,000; Save → Basic 12,000", async ({ browser, baseURL }) => {
    localDb("R-2773").psql(`update public.attendance_settings set payroll_basic_pct = 40 where tenant_id = ${E2E_TENANT_SQL};`);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await addEmployeeWithGross(page, "CT R2773 New B", "30000");
      await expect(dlg).toContainText("Basic Salary (40%):", { timeout: 30_000 });
      await expect(dlg).toContainText("₹12,000");
      await dlg.getByRole("button", { name: "Save" }).click();
      await expect(dlg).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => empRow("CT R2773 New B"), { timeout: 15_000 }).toBe("30000,12000");
    } finally {
      localDb("R-2773").psql(`update public.attendance_settings set payroll_basic_pct = 50 where tenant_id = ${E2E_TENANT_SQL};`);
      await page.context().close();
    }
  });

  test("Step 3: Edit employee (30,000 / Basic 15,000) → gross 40,000 → Basic follows its share (₹20,000); a Basic typed by hand stays when the gross changes", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /Employees/);
      const actions = await onlyOne(page.getByRole("button", { name: `Actions for ${OLD_NAME}`, exact: true }).filter({ visible: true }), `Actions for ${OLD_NAME}`);
      await actions.click();
      await page.getByRole("menuitem", { name: "Edit profile & salary" }).click();
      const dlg = page.getByRole("dialog", { name: "Edit employee" });
      await expect(dlg).toBeVisible();
      await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
      const gross = dlg.locator("#payroll-monthly-gross-salary-base");
      await expect(gross).toBeEnabled({ timeout: 60_000 }); // locked until salary revisions load (R-2699)
      await fillKept(gross, "40000");
      await expect(dlg).toContainText("Basic Salary (50%):");
      await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
      const basic = dlg.locator("#payroll-basic-month");
      await expect(basic).toHaveValue("20000");
      await fillKept(basic, "18000");
      await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
      await fillKept(gross, "44000");
      await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
      await expect(basic).toHaveValue("18000");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(empRow(OLD_NAME)).toBe("30000,15000");
    } finally {
      await page.context().close();
    }
  });
});
