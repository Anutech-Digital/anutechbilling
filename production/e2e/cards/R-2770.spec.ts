/**
 * Card test — R-2770 (Hitesh) "Employees table: 'CTC / month' column just before 'Gross / month'
 * (same CTC as the CTC register + employee drawer)"; Revise salary uses the same policy.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2770`.
 *
 * Data (local docker DB only, fixed id, removed after): "CT R2770 Meera" — ₹30,000 a month,
 * Basic ₹15,000, PF on (capped), ESI off, no revisions, nothing booked. Its CTC depends on the
 * company payroll policy (default: 30,000 + PF 1,800 + gratuity 721 = ₹32,521), so the steps
 * compare the SAME employee's number across the screens (the unit test ctc-r2770.test.ts pins
 * the policy cases).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const EMP = "c2770000-0000-4000-8000-000000000001";
const NAME = "CT R2770 Meera";

function clean(): void {
  localDb("R-2770").psql(`delete from public.employees where id = '${EMP}';`);
}

function seed(): void {
  localDb("R-2770").psql(`insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, pf_full_wage, joining_date, is_active)
    values ('${EMP}', ${E2E_TENANT_SQL}, '${NAME}', 30000, 15000, 0, false, true, false, '2026-01-01', true);`);
}

const rupees = (s: string | null | undefined) => Number((s ?? "").replace(/[^\d]/g, ""));

function employeeRow(page: Page) {
  return page.locator("table tbody tr").filter({ hasText: NAME });
}

async function tableCtc(page: Page): Promise<string> {
  await openAppPage(page, "/accounting/employees", /Employees/);
  const cell = employeeRow(page).getByTestId("employee-ctc-month");
  await expect(cell).toHaveText(/^₹[\d,]+$/, { timeout: 60_000 });
  return (await cell.textContent())!.trim();
}

test.describe("R-2770 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Employees table — 'CTC / month' just before 'Gross / month', a rupee figure (never ₹0) for the employee", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /Employees/);
      const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "CTC / month" }) });
      await expect(table.getByRole("columnheader", { name: "Gross / month" })).toBeVisible({ timeout: 60_000 });
      const headers = (await table.getByRole("columnheader").allTextContents()).map((h) => h.trim());
      expect(headers.indexOf("CTC / month")).toBe(headers.indexOf("Gross / month") - 1);
      const ctc = await tableCtc(page);
      expect(ctc).not.toBe("₹0");
      expect(rupees(ctc)).toBeGreaterThanOrEqual(30_000); // CTC is never below the gross
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the drawer's Monthly CTC and the Salary Register CTC tab show the same number; Revise salary 'Now' CTC = 12 × it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const ctc = await tableCtc(page);
      await employeeRow(page).locator("td").first().click(); // the row opens the profile drawer
      const drawer = page.getByRole("dialog");
      await expect(drawer).toContainText(`Monthly CTC: ${ctc}/mo`, { timeout: 60_000 });

      // Revise salary (in the drawer) reads the same CTC with the same policy
      await drawer.getByRole("button", { name: "Revise salary" }).click();
      const rev = page.getByRole("dialog", { name: `Revise salary — ${NAME}` });
      await expect(rev).toBeVisible();
      const annual = (rupees(ctc) * 12).toLocaleString("en-IN");
      await expect(rev).toContainText(`CTC ₹${annual}/yr`, { timeout: 60_000 });
      await expect(rev.locator("#revise-ctc")).toHaveValue(String(rupees(ctc) * 12), { timeout: 60_000 });
      await rev.getByRole("button", { name: "Cancel" }).click();

      await openAppPage(page, "/accounting/salary-register", /Salary/);
      await page.getByRole("button", { name: /CTC \(Cost to Company\) Master Register/ }).click();
      const reg = page.locator("table tbody tr").filter({ hasText: NAME });
      await expect(reg).toContainText(ctc, { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: at 1280 px with the sidebar open, Score / Status / Actions stay on screen (no side-scroll)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await tableCtc(page);
      const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "CTC / month" }) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const clipped = await table.evaluate((t) => { const c = t.parentElement!; return c.scrollWidth - c.clientWidth; });
      expect(clipped).toBeLessThanOrEqual(0);
      for (const h of ["Status", "Actions"]) {
        const box = await table.getByRole("columnheader", { name: h }).boundingBox();
        expect(box && box.x + box.width, h).toBeLessThanOrEqual(1280);
      }
      const box = await employeeRow(page).getByRole("button", { name: `Actions for ${NAME}`, exact: true }).boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(1280);
    } finally {
      await page.context().close();
    }
  });
});
