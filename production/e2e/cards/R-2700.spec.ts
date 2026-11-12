/**
 * Card test — R-2700 "CTC fills Monthly Gross by the company policy; company ESI / PF /
 * gratuity policy settings" (Hitesh, 12 Nov 2026, items 1 + 8).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2700`.
 *
 * Data (E2E Test Co + the local docker DB only, fixed ids / fixed names, removed after):
 *   · CT R2700 Old — saved gross ₹30,000, no Basic, PF on, ESI off (the R-2698 31,347 case);
 *   · CT R2700 New A / New B — made by the steps through Add employee;
 *   · the E2E Test Co payroll policy — put back to the defaults after the run.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const OLD = "c2700000-0000-4000-8000-000000000001";
const NEW_NAMES = "'CT R2700 New A','CT R2700 New B'";
const DEFAULT_POLICY_SQL = `payroll_pf_default = false, payroll_pf_full_wage_default = false, payroll_esi_default = true,
  payroll_gratuity = true, payroll_ctc_includes_employer = true, payroll_basic_pct = 50`;

function clean(): void {
  localDb("R-2700").psql(`begin;
    delete from public.employees where tenant_id = ${E2E_TENANT_SQL} and (id = '${OLD}' or name in (${NEW_NAMES}));
    update public.attendance_settings set ${DEFAULT_POLICY_SQL} where tenant_id = ${E2E_TENANT_SQL};
    commit;`);
}

function seed(): void {
  localDb("R-2700").psql(`begin;
    insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, joining_date, is_active)
      values ('${OLD}', ${E2E_TENANT_SQL}, 'CT R2700 Old', 30000, null, 0, false, true, '2026-01-01', true);
    commit;`);
}

function empRow(name: string): string {
  return localDb("R-2700").one(`select monthly_gross::text || ',' || coalesce(basic_monthly::text, 'null') || ',' || pf_applicable::text
    from public.employees where tenant_id = ${E2E_TENANT_SQL} and name = '${name}'`);
}

async function addEmployeeWithCtc(page: Page, name: string, ctc: string) {
  await openAppPage(page, "/accounting/employees", /Employees/);
  await (await onlyOne(page.getByRole("main").getByRole("button", { name: "Add employee", exact: true }).filter({ visible: true }), "Add employee")).click();
  const dlg = page.getByRole("dialog", { name: "Add employee" });
  await expect(dlg).toBeVisible();
  await fillKept(dlg.locator("#payroll-full-name"), name);
  await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
  await fillKept(dlg.locator("#payroll-annual-ctc-yr"), ctc);
  return dlg;
}

test.describe("R-2700 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Employees → Payroll policy → Edit policy: PF on for new employees, CTC is the gross pay, Basic 40% → Save → the summary says so", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/employees", /Employees/);
    const card = page.getByTestId("payroll-policy-card");
    const edit = card.getByRole("button", { name: "Edit policy" });
    await waitForHydrated(page, card.getByTestId("payroll-policy-summary"));
    await edit.click();
    await card.getByRole("checkbox", { name: /PF for new employees/ }).check();
    await card.getByRole("radio", { name: /Is the gross pay/ }).check();
    await fillKept(card.locator("#policy-basic-pct"), "40");
    await card.getByRole("button", { name: "Save policy" }).click();
    const summary = card.getByTestId("payroll-policy-summary");
    await expect(summary).toContainText("PF: on for new employees — 12% of Basic + DA up to ₹25,000", { timeout: 30_000 });
    await expect(summary).toContainText("CTC = gross pay — employer PF / ESI / gratuity are paid on top");
    await expect(summary).toContainText("Basic: 40% of the monthly salary");
  });

  test("Step 2: Add employee → CTC 3,60,000 → Monthly Gross fills 30,000 (CTC ÷ 12), PF on from the policy; Save → saved 30,000 / Basic 12,000 / PF on", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await addEmployeeWithCtc(page, "CT R2700 New A", "360000");
    await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("30000");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("Monthly gross ₹30,000 = CTC ₹3,60,000 ÷ 12.");
    await expect(dlg.getByTestId("ctc-statutory-switches")).toContainText("PF: on");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => empRow("CT R2700 New A"), { timeout: 15_000 }).toBe("30000,12000,true");
  });

  test("Step 3: policy → CTC includes employer PF / ESI / gratuity → Add employee, CTC 3,60,000 → gross 27,983 (30,000 − PF 1,440 − gratuity 577); gross typed by hand is kept", async ({ browser, baseURL }) => {
    localDb("R-2700").psql(`update public.attendance_settings set payroll_ctc_includes_employer = true where tenant_id = ${E2E_TENANT_SQL};`);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await addEmployeeWithCtc(page, "CT R2700 New B", "360000");
    const gross = dlg.locator("#payroll-monthly-gross-salary-base");
    await expect(gross).toHaveValue("27983");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("Monthly gross ₹27,983 = CTC ₹3,60,000 ÷ 12 (₹30,000) − employer PF ₹1,440 − gratuity ₹577.");
    await fillKept(gross, "28000");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("Monthly gross ₹28,000 is entered by hand.");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => empRow("CT R2700 New B"), { timeout: 15_000 }).toBe("28000,12000,true");
  });

  test("Step 4: existing employee (saved ₹30,000) → Edit → CTC tab shows ₹30,000 as saved (not 31,347); the policy did not change their switches", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/employees", /Employees/);
    const actions = await onlyOne(page.getByRole("button", { name: "Actions for CT R2700 Old", exact: true }).filter({ visible: true }), "Actions for CT R2700 Old");
    await actions.click();
    await page.getByRole("menuitem", { name: "Edit profile & salary" }).click();
    const dlg = page.getByRole("dialog", { name: "Edit employee" });
    await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
    await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("30000");
    await expect(dlg.getByTestId("ctc-formula")).toContainText("Monthly gross ₹30,000 is the saved salary");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect(empRow("CT R2700 Old")).toBe("30000,null,true");
  });
});
