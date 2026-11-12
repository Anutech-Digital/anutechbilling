/**
 * Card test — R-2698 "ESI / PF set to No on an employee still deducts ESI / PF; per-employee PF
 * basis (capped / full Basic + DA); delete with booked salary lit 'an error was caught'".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2698`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · CT R2698 Emp     — gross ₹30,000, Basic ₹15,000, ESI + PF on, joined 1 Jan 2026;
 *   · CT R2698 Booked  — one booked September 2026 salary with PF ₹1,800.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const EMP = "c2698000-0000-4000-8000-000000000001";
const BOOKED = "c2698000-0000-4000-8000-000000000002";
const IDS = `'${EMP}','${BOOKED}'`;

function clean(): void {
  localDb("R-2698").psql(`begin;
    delete from public.salary_payments where employee_id in (${IDS}) and tenant_id = ${E2E_TENANT_SQL};
    delete from public.employees where id in (${IDS}) and tenant_id = ${E2E_TENANT_SQL};
    commit;`);
}

function seed(): void {
  localDb("R-2698").psql(`begin;
    insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, joining_date, is_active)
      values ('${EMP}', ${E2E_TENANT_SQL}, 'CT R2698 Emp', 30000, 15000, 0, true, true, '2026-01-01', true),
             ('${BOOKED}', ${E2E_TENANT_SQL}, 'CT R2698 Booked', 20000, 15000, 0, false, true, '2026-01-01', true);
    insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, pf, pf_employer, net)
      values (${E2E_TENANT_SQL}, '${BOOKED}', '2026-09', '2026-09-30', 20000, 1800, 1800, 18200);
    commit;`);
}

function flags(): string {
  return localDb("R-2698").one(`select esi_applicable::text || ',' || pf_applicable::text || ',' || pf_full_wage::text from public.employees where id = '${EMP}'`);
}

async function openEdit(page: Page, name: string) {
  await openAppPage(page, "/accounting/employees", /Employees/);
  // Rows are buttons here (the whole row opens the profile) — find the row's own Actions button.
  const actions = await onlyOne(page.getByRole("button", { name: `Actions for ${name}`, exact: true }).filter({ visible: true }), `Actions for ${name}`);
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit profile & salary" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit employee" });
  await expect(dlg).toBeVisible();
  return dlg;
}

async function payDialog(page: Page, name: string) {
  await openAppPage(page, "/accounting/payroll", /Payroll/);
  const pay = await onlyOne(page.locator("tr", { hasText: name }).filter({ visible: true }).getByRole("button", { name: "Pay salary" }), `Pay salary for ${name}`);
  await pay.click();
  const dlg = page.getByRole("dialog", { name: `Pay salary — ${name}` });
  await expect(dlg).toBeVisible();
  return dlg;
}

test.describe("R-2698 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Employees → CT R2698 Emp → Edit → Statutory & Access: untick ESI + PF → Save → saved; the CTC tab shows PF off, ESI off and no PF / ESI deduction", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    let dlg = await openEdit(page, "CT R2698 Emp");
    await dlg.getByRole("button", { name: /Statutory & Access/ }).click();
    const esi = dlg.getByRole("checkbox", { name: /ESI applicable/ });
    const pf = dlg.getByRole("checkbox", { name: /PF applicable/ });
    await waitForHydrated(page, esi);
    await expect(esi).toBeChecked();
    await expect(dlg.getByTestId("esi-rule")).toContainText("above ₹21,000, so ESI will be ₹0");
    await esi.uncheck();
    await pf.uncheck();
    await expect(dlg.getByTestId("statutory-from-now")).toContainText("Applies to salaries you pay from now on");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect.poll(flags, { timeout: 15_000 }).toBe("false,false,false");

    dlg = await openEdit(page, "CT R2698 Emp");
    await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
    await expect(dlg.getByTestId("ctc-statutory-switches")).toContainText("PF: off");
    await expect(dlg.getByTestId("ctc-statutory-switches")).toContainText("ESI: off");
    await expect(dlg.getByText("No PF / ESI deducted.")).toBeVisible();
    await expect(dlg.getByText("Employee PF (12%):")).toHaveCount(0);
    // "Apply Salary Structure" must not switch PF / ESI back on.
    await dlg.getByRole("button", { name: /Apply Salary Structure/ }).click();
    await expect(dlg.getByTestId("ctc-statutory-switches")).toContainText("PF: off");
    await dlg.getByRole("button", { name: "Cancel" }).click();
  });

  test("Step 2: Payroll → Pay salary for CT R2698 Emp → PF — employee 0 and ESI — employee 0", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await payDialog(page, "CT R2698 Emp");
    await expect(dlg.locator("#payroll-pf-employee")).toHaveValue("0");
    await expect(dlg.locator("#payroll-esi-employee")).toHaveValue("0");
  });

  test("Step 3: PF on, Basic ₹40,000: capped → PF = 12% of the month's ceiling (₹3,000 for Oct 2026); Statutory → 'Full Basic + DA' → Save → PF ₹4,800", async ({ browser, baseURL }) => {
    localDb("R-2698").psql(`update public.employees set pf_applicable = true, pf_full_wage = false, monthly_gross = 60000, basic_monthly = 40000 where id = '${EMP}';`);
    const page = await pageAs(browser, baseURL, "owner");
    let pay = await payDialog(page, "CT R2698 Emp");
    await expect(pay.locator("#payroll-pf-employee")).toHaveValue("3000");
    await pay.getByRole("button", { name: "Cancel" }).click();

    const dlg = await openEdit(page, "CT R2698 Emp");
    await dlg.getByRole("button", { name: /Statutory & Access/ }).click();
    await dlg.getByRole("radio", { name: /Full Basic \+ DA/ }).check();
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect.poll(flags, { timeout: 15_000 }).toBe("false,true,true");

    pay = await payDialog(page, "CT R2698 Emp");
    await expect(pay.locator("#payroll-pf-employee")).toHaveValue("4800");
  });

  test("Step 4: Employees → CT R2698 Booked → Delete employee → 'can't be deleted' names Sep 2026 before anything is deleted; Help stays normal (no 'error was caught')", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/employees", /Employees/);
    const actions = await onlyOne(page.getByRole("button", { name: "Actions for CT R2698 Booked", exact: true }).filter({ visible: true }), "Actions for CT R2698 Booked");
    await actions.click();
    // The owner's role loads after the list — "Start exit" in the menu proves it is in.
    await expect(page.getByRole("menuitem", { name: "Start exit" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("menuitem", { name: "Delete employee" }).click();
    const dlg = page.getByRole("dialog", { name: "CT R2698 Booked can't be deleted" });
    await expect(dlg).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toContainText("Sep 2026");
    await expect(dlg.getByRole("button", { name: "Start exit" })).toBeVisible();
    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("button", { name: /an error was caught/ })).toHaveCount(0);
    expect(localDb("R-2698").one(`select count(*) from public.employees where id = '${BOOKED}'`)).toBe("1");
  });
});
