/**
 * Card test — R-2743 "Payroll follow-ups from the R-2733 review: CTC register Net total ₹0 while
 * loading; Revise salary take-home still the old net (PT, no TDS); Basic % not recomputed on a DA change".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2743`.
 *
 * Data (local docker DB only, fixed id, removed after): "CT R2743 Darshan" — ₹30,000 a month, Basic
 * NOT set, PF on (capped), ESI off, no revisions, nothing booked. In-hand = 30,000 − PF 3,000 − TDS 0 = ₹27,000.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const EMP = "c2743000-0000-4000-8000-000000000001";
const NAME = "CT R2743 Darshan";

function clean(): void {
  localDb("R-2743").psql(`delete from public.employees where id = '${EMP}';`);
}

function seed(): void {
  localDb("R-2743").psql(`insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, pf_full_wage, joining_date, is_active)
    values ('${EMP}', ${E2E_TENANT_SQL}, '${NAME}', 30000, null, 0, false, true, false, '2026-01-01', true);`);
}

function saved(): string {
  return localDb("R-2743").one(`select monthly_gross::text || ',' || coalesce(basic_monthly::text, 'null') || ',' || coalesce(da_monthly::text, 'null') from public.employees where id = '${EMP}'`);
}

async function openEditDialog(page: Page) {
  await openAppPage(page, "/accounting/employees", /Employees/);
  const actions = await onlyOne(page.getByRole("button", { name: `Actions for ${NAME}`, exact: true }).filter({ visible: true }), `Actions for ${NAME}`);
  await actions.click();
  await page.getByRole("menuitem", { name: "Edit profile & salary" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit employee" });
  await expect(dlg).toBeVisible();
  return dlg;
}

test.describe("R-2743 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: CTC register — while the payslips load the Net Take Home total shows '…' and Export is off; then the total is the sum of the rows (never ₹0)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // Hold the payslip reads (salary_payments) for 6 s so the loading state is on screen long enough to read.
      let held = 0;
      await page.route(/\/rest\/v1\/salary_payments\?/, async (route) => {
        held += 1;
        await new Promise((r) => setTimeout(r, 6_000));
        await route.fallback().catch(() => { /* page closed */ });
      });
      await openAppPage(page, "/accounting/salary-register", /Salary/);
      await page.getByRole("button", { name: /CTC \(Cost to Company\) Master Register/ }).click();
      const total = page.getByTestId("ctc-net-total");
      await expect(total).toBeVisible({ timeout: 60_000 });
      await expect(total).toHaveText("…");
      await expect(total).not.toContainText("₹0");
      const exportBtn = page.getByRole("button", { name: "Export CTC Register CSV" });
      await expect(exportBtn).toBeDisabled();
      expect(held).toBeGreaterThan(0);
      // …then the real figure: the rows' nets added up, and the export is back on.
      await expect(total).not.toHaveText("…", { timeout: 60_000 });
      await expect(exportBtn).toBeEnabled();
      // every employee row's own net cell (bold emerald) — the totals row's cell is not bold
      const nets = (await page.locator("table tbody tr td.text-emerald-700.font-bold").allInnerTexts())
        .filter((t) => /^₹/.test(t.trim())).map((t) => Number(t.replace(/[₹,s]/g, "")));
      const sum = nets.reduce((s, n) => s + n, 0);
      const shown = Number(((await total.textContent()) ?? "").replace(/[₹,]/g, ""));
      expect(nets.length).toBeGreaterThan(0);
      expect(shown).toBe(sum);
      expect(shown).toBeGreaterThanOrEqual(27_000); // our ₹27,000 row is in it
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Revise salary — 'Take-home (full month)' for the unchanged salary = the Employees table's In-hand ₹27,000; a raise to ₹40,000 → ₹37,000 (no PT)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /Employees/);
      const row = page.locator("table tbody tr").filter({ hasText: NAME });
      await expect(row.getByTestId("employee-in-hand")).toHaveText("₹27,000", { timeout: 60_000 });
      await page.locator("table").getByRole("button", { name: `Open ${NAME}'s profile` }).click();
      const section = await onlyOne(page.getByRole("dialog").getByTestId("salary-revisions"), "Salary revisions");
      await section.getByRole("button", { name: "Revise salary" }).click();
      const dlg = page.getByRole("dialog", { name: `Revise salary — ${NAME}` });
      await expect(dlg.locator("#revise-effective")).not.toHaveValue("", { timeout: 60_000 });
      const takeHome = dlg.getByTestId("revise-take-home");
      await expect(takeHome).toHaveText("Take-home (full month) ₹27,000", { timeout: 60_000 });
      await expect(takeHome).toHaveAttribute("title", /^Full month: ₹27,000 = gross ₹30,000 − PF ₹3,000/);
      await expect(dlg).not.toContainText("Take-home about");
      await fillKept(dlg.locator("#revise-gross"), "40000");
      // 40,000 − PF 3,000 (whole gross, capped at the ₹25,000 ceiling) − TDS 0 (₹4.8 L a year: nil under 87A)
      await expect(takeHome).toHaveText("Take-home (full month) ₹37,000");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(saved()).toBe("30000,null,0");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: CTC tab — Basic 60% of ₹30,000 = ₹18,000; DA ₹15,000 typed → Basic re-split to ₹15,000 (gross − DA), DA back to 0 → ₹18,000; Save keeps Basic + DA ≤ gross", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openEditDialog(page);
      await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
      await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toBeEnabled({ timeout: 60_000 });
      await dlg.getByRole("button", { name: /Custom Edit Basic %/ }).click();
      await dlg.locator("#payroll-basic-salary").selectOption("0.6");
      await expect(dlg).toContainText("Basic Salary (60%):");
      await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
      await expect(dlg.locator("#payroll-basic-month")).toHaveValue("18000");
      await fillKept(dlg.locator("#payroll-da-month"), "15000");
      await expect(dlg.locator("#payroll-basic-month")).toHaveValue("15000");
      await expect(dlg).not.toContainText("Basic + DA is more than gross");
      await fillKept(dlg.locator("#payroll-da-month"), "0");
      await expect(dlg.locator("#payroll-basic-month")).toHaveValue("18000");
      await fillKept(dlg.locator("#payroll-da-month"), "5000");
      await expect(dlg.locator("#payroll-basic-month")).toHaveValue("18000"); // 18,000 + 5,000 ≤ 30,000 — the % stays
      await dlg.getByRole("button", { name: "Save" }).click();
      await expect(dlg).toBeHidden({ timeout: 30_000 });
      expect(saved()).toBe("30000,18000,5000");
    } finally {
      await page.context().close();
    }
  });
});
