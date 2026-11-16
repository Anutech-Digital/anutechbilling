/**
 * Card test — R-2722 "Payroll form follow-ups" (staging 13 Nov on Prashant: gross 17,850, Basic 10,000).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2722`. Item 4 (Revise salary "already booked" wording)
 * is checked in e2e/cards/R-2699.spec.ts Step 3.
 *
 * Data (local docker DB only, fixed id, removed after): "CT R2722 Prashant" — ₹17,850 a month,
 * Basic ₹10,000, PF on, ESI on, no revisions, nothing booked.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const EMP = "c2722000-0000-4000-8000-000000000001";
const NAME = "CT R2722 Prashant";

function clean(): void {
  localDb("R-2722").psql(`delete from public.employees where id = '${EMP}';`);
}

function seed(): void {
  localDb("R-2722").psql(`insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, joining_date, is_active)
    values ('${EMP}', ${E2E_TENANT_SQL}, '${NAME}', 17850, 10000, 0, true, true, '2026-01-01', true);`);
}

function saved(): string {
  return localDb("R-2722").one(`select monthly_gross::text || ',' || coalesce(basic_monthly::text, 'null') from public.employees where id = '${EMP}'`);
}

async function openCtcTab(page: Page) {
  await openAppPage(page, "/accounting/employees", /Employees/);
  const actions = await onlyOne(page.getByRole("button", { name: `Actions for ${NAME}`, exact: true }).filter({ visible: true }), `Actions for ${NAME}`);
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit profile & salary" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit employee" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
  // the gross box is locked until the salary revisions have loaded (R-2699)
  await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toBeEnabled({ timeout: 60_000 });
  return dlg;
}

test.describe("R-2722 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Edit → CTC tab → type CTC 3,00,000 → clear it → gross 17,850 and the breakdown card shows the saved figures (CTC ₹20,112/mo), not ₹0 / ₹10,000; Save keeps 17,850", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openCtcTab(page);
    const gross = dlg.locator("#payroll-monthly-gross-salary-base");
    const ctc = dlg.locator("#payroll-annual-ctc-yr");
    await expect(dlg).toContainText("Monthly CTC: ₹20,112/mo");
    await fillKept(ctc, "300000");
    await expect(gross).toHaveValue("23319");
    await ctc.fill("");
    await expect(gross).toHaveValue("17850");
    await expect(dlg).toContainText("Monthly CTC: ₹20,112/mo");
    await expect(dlg).not.toContainText("Monthly CTC: ₹0/mo");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("(monthly gross ₹17,850");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    expect(saved()).toBe("17850,10000");
  });

  test("Step 2: CTC 1,20,000 with Custom Basic ₹20,000 (over budget) → Apply Salary Structure is off with the reason", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openCtcTab(page);
    const apply = dlg.getByRole("button", { name: /Apply Salary Structure/ });
    await expect(apply).toBeEnabled();
    await dlg.getByRole("button", { name: /Custom Edit Basic %/ }).click();
    await fillKept(dlg.locator("#payroll-custom-basic-mo"), "20000");
    await fillKept(dlg.locator("#payroll-annual-ctc-yr"), "120000");
    await expect(apply).toBeDisabled();
    await expect(dlg.getByTestId("apply-structure-blocked")).toHaveText("Basic is more than this CTC allows — lower the Basic % or raise the CTC first.");
    await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("17850");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect(saved()).toBe("17850,10000");
  });

  test("Step 3: Statutory & Access → untick ESI and PF → CTC tab: gross stays 17,850 (was 17,890), CTC 2,19,972", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openCtcTab(page);
    await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
    await dlg.getByRole("checkbox", { name: /ESI applicable/ }).uncheck();
    await dlg.getByRole("checkbox", { name: /PF applicable/ }).uncheck();
    await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
    await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("17850");
    await expect(dlg.locator("#payroll-annual-ctc-yr")).toHaveValue("219972");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("CTC ₹2,19,972 = (monthly gross ₹17,850 + gratuity ₹481) × 12.");
    await dlg.getByRole("button", { name: /Apply Salary Structure/ }).click();
    await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("17850");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect(saved()).toBe("17850,10000");
  });
});
