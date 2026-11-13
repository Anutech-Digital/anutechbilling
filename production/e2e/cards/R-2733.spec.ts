/**
 * Card test — R-2733 "Payroll (Hitesh, 13 Nov): Monthly CTC → Annual + Monthly Net Pay; Basic % works;
 * link to where Basic is set; Employees table In-hand / month".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login (Owner).
 * Run: `node scripts/ops/card-tests.mjs R-2733`.
 *
 * Data (local docker DB only, fixed id, removed after): "CT R2733 Darshan" — shaped like Hitesh's
 * Darshan: ₹30,000 a month, Basic NOT set, PF on (capped), ESI off, no revisions, nothing booked.
 * In-hand = 30,000 − PF 3,000 (whole gross, capped at the ₹25,000 ceiling) − TDS 0 (nil under 87A) = ₹27,000.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const EMP = "c2733000-0000-4000-8000-000000000001";
const NAME = "CT R2733 Darshan";

function clean(): void {
  localDb("R-2733").psql(`delete from public.employees where id = '${EMP}';`);
}

function seed(): void {
  localDb("R-2733").psql(`insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, da_monthly, esi_applicable, pf_applicable, pf_full_wage, joining_date, is_active)
    values ('${EMP}', ${E2E_TENANT_SQL}, '${NAME}', 30000, null, 0, false, true, false, '2026-01-01', true);`);
}

function saved(): string {
  return localDb("R-2733").one(`select monthly_gross::text || ',' || coalesce(basic_monthly::text, 'null') from public.employees where id = '${EMP}'`);
}

function employeeRow(page: Page) {
  return page.locator("table tbody tr").filter({ hasText: NAME });
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

test.describe("R-2733 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Employees table — 'Gross / month' ₹30,000 and 'In-hand / month' ₹27,000; fits 1280 px", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openAppPage(page, "/accounting/employees", /Employees/);
      const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "In-hand / month" }) });
      await expect(table.getByRole("columnheader", { name: "Gross / month" })).toBeVisible({ timeout: 60_000 });
      await expect(table.getByRole("columnheader", { name: "Monthly salary" })).toHaveCount(0);
      const row = employeeRow(page);
      await expect(row).toContainText("₹30,000", { timeout: 60_000 });
      await expect(row.getByTestId("employee-in-hand")).toHaveText("₹27,000", { timeout: 60_000 });
      await expect(row.getByTestId("employee-in-hand")).toHaveAttribute("title", /^\w+ \d{4} — Full month: ₹27,000 = gross ₹30,000 − PF ₹3,000/);
      // fits 1280: no sideways scroll on the page, the Actions column is on screen
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      // …and the table's own card does not clip it (the card is overflow-hidden — R-2725's check)
      const clipped = await table.evaluate((t) => { const c = t.parentElement!; return c.scrollWidth - c.clientWidth; });
      expect(clipped).toBeLessThanOrEqual(0);
      const box = await row.getByRole("button", { name: `Actions for ${NAME}`, exact: true }).boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(1280);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: In-hand equals Pay salary's net for the same employee and month (full month, nothing typed)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /Employees/);
      const inHand = (await employeeRow(page).getByTestId("employee-in-hand").textContent({ timeout: 60_000 }))?.trim();
      await openAppPage(page, "/accounting/payroll", /^Payroll$/);
      const prow = page.locator("table tbody tr").filter({ hasText: NAME });
      await expect(prow.getByRole("button", { name: "Pay salary" })).toBeVisible({ timeout: 60_000 });
      await prow.getByRole("button", { name: "Pay salary" }).click();
      const dlg = page.getByRole("dialog", { name: `Pay salary — ${NAME}` });
      await expect(dlg).toBeVisible();
      const full = dlg.getByRole("button", { name: /Pay full month/ });
      if (await full.count()) await full.click();
      await expect(dlg.locator("#payroll-salary-to-pay")).toHaveValue("30000", { timeout: 60_000 });
      await expect(dlg.locator("#payroll-pf-employee")).toHaveValue("3000", { timeout: 60_000 });
      const net = dlg.locator("div").filter({ hasText: /^Net pay \(cash out\)/ }).last();
      await expect(net).toContainText(inHand ?? "missing", { timeout: 60_000 });
      await dlg.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: CTC tab — Monthly CTC 25,000 → Annual 3,00,000 and Monthly Net Pay shown live", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openCtcTab(page);
      await expect(dlg.getByTestId("ctc-monthly-net-pay")).toContainText("₹27,000", { timeout: 60_000 });
      await fillKept(dlg.locator("#payroll-monthly-ctc-mo"), "25000");
      await expect(dlg.locator("#payroll-annual-ctc-yr")).toHaveValue("300000");
      const gross = dlg.locator("#payroll-monthly-gross-salary-base");
      await expect(gross).not.toHaveValue("30000");
      const g = Number(await gross.inputValue());
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(25000);
      await expect(dlg.getByTestId("ctc-monthly-net-pay")).toContainText(`gross ₹${g.toLocaleString("en-IN")}`);
      await expect(dlg.getByTestId("ctc-monthly-net-pay")).toContainText("Full month:");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(saved()).toBe("30000,null");
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Basic % works with no CTC typed — 40% → Basic ₹12,000 in the card; Save writes it; the line links to Payroll policy", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openCtcTab(page);
      await dlg.getByTestId("change-basic").click();
      const pct = dlg.locator("#payroll-basic-salary");
      await expect(pct).toBeFocused();
      await expect(dlg.getByTestId("basic-pct-note")).toContainText("No CTC typed: Basic % sets this employee's Basic");
      await pct.selectOption("0.4");
      await expect(dlg).toContainText("Basic Salary (40%):");
      await expect(dlg.getByTestId("ctc-formula")).toContainText("(monthly gross ₹30,000");
      await expect(dlg.locator("#payroll-monthly-gross-salary-base")).toHaveValue("30000");
      await dlg.getByRole("button", { name: "Save" }).click();
      await expect(dlg).toBeHidden({ timeout: 30_000 });
      expect(saved()).toBe("30000,12000");

      const dlg2 = await openCtcTab(page);
      await dlg2.getByTestId("change-basic").click();
      // Gross typed after a Basic % → the Basic follows it (40% of 20,000 = 8,000), never stays above it.
      await dlg2.getByTestId("change-basic").click();
      await dlg2.locator("#payroll-basic-salary").selectOption("0.4");
      await fillKept(dlg2.locator("#payroll-monthly-gross-salary-base"), "20000");
      await expect(dlg2).toContainText("Basic Salary (40%):");
      await expect(dlg2.locator("#payroll-monthly-gross-salary-base")).toHaveValue("20000");
      // The policy link opens the Employees page's Payroll policy card in a new tab — the dialog keeps its edits.
      const [tab] = await Promise.all([page.context().waitForEvent("page"), dlg2.getByTestId("open-payroll-policy").click()]);
      await expect(dlg2).toBeVisible();
      await tab.waitForLoadState();
      expect(new URL(tab.url()).pathname + new URL(tab.url()).hash).toBe("/accounting/employees#payroll-policy");
      await expect(tab.locator("#payroll-policy")).toBeInViewport({ timeout: 60_000 });
      await dlg2.getByRole("button", { name: "Cancel" }).click();
      expect(saved()).toBe("30000,12000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 5 (R-2727 item 4): Custom Basic 20,000 with CTC 1,20,000 → 'Basic Salary (more than this CTC allows)', no '200%', Apply off with the same reason", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openCtcTab(page);
      await dlg.getByRole("button", { name: /Custom Edit Basic %/ }).click();
      await fillKept(dlg.locator("#payroll-custom-basic-mo"), "20000");
      await fillKept(dlg.locator("#payroll-annual-ctc-yr"), "120000");
      await expect(dlg).toContainText("Monthly CTC: ₹10,000/mo");
      await expect(dlg).toContainText("Basic Salary (more than this CTC allows):");
      await expect(dlg).not.toContainText("(200%)");
      await expect(dlg.getByRole("button", { name: /Apply Salary Structure/ })).toBeDisabled();
      await expect(dlg.getByTestId("apply-structure-blocked")).toHaveText("Basic is more than this CTC allows — lower the Basic % or raise the CTC first.");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(saved()).toBe("30000,12000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 6 (review LOW 3 + 4): Basic % before the gross applies when the gross is typed (new employee); clearing Custom Basic gives back the Statutory-tab Basic typed this session", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // LOW 3 — Add employee: pick 40% first, then type the gross
      await openAppPage(page, "/accounting/employees", /Employees/);
      await (await onlyOne(page.getByRole("main").getByRole("button", { name: "Add employee", exact: true }).filter({ visible: true }), "Add employee")).click();
      const add = page.getByRole("dialog", { name: "Add employee" });
      await add.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
      await add.getByRole("button", { name: /Custom Edit Basic %/ }).click();
      await add.locator("#payroll-basic-salary").selectOption("0.4");
      await fillKept(add.locator("#payroll-monthly-gross-salary-base"), "20000");
      await expect(add).toContainText("Basic Salary (40%):");
      await add.getByRole("button", { name: /Statutory & Access/ }).first().click();
      await expect(add.locator("#payroll-basic-month")).toHaveValue("8000");
      await add.getByRole("button", { name: "Cancel" }).click();

      // LOW 4 — existing employee: Statutory Basic 9,000 → Custom Basic 11,000 → cleared → 9,000 (not the saved 12,000)
      const dlg = await openCtcTab(page);
      await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
      await fillKept(dlg.locator("#payroll-basic-month"), "9000");
      await dlg.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
      await dlg.getByRole("button", { name: /Custom Edit Basic %/ }).click();
      await fillKept(dlg.locator("#payroll-custom-basic-mo"), "11000");
      await dlg.locator("#payroll-custom-basic-mo").fill("");
      await dlg.getByRole("button", { name: /Statutory & Access/ }).first().click();
      await expect(dlg.locator("#payroll-basic-month")).toHaveValue("9000");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      expect(saved()).toBe("30000,12000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 7 (owner: PT does not apply): profile drawer and CTC register show the same net as In-hand — ₹28,560 (30,000 − PF 1,440 on Basic 12,000), no PT", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /Employees/);
      const row = employeeRow(page);
      await expect(row.getByTestId("employee-in-hand")).toHaveText("₹28,560", { timeout: 60_000 });
      await row.locator("td").first().click(); // the row itself opens the profile drawer
      await expect(page.getByTestId("drawer-net-pay")).toHaveText("₹28,560", { timeout: 60_000 });
      await expect(page.getByRole("dialog")).not.toContainText("PT -");

      await openAppPage(page, "/accounting/salary-register", /Salary/);
      await page.getByRole("button", { name: /CTC \(Cost to Company\) Master Register/ }).click();
      const reg = page.locator("table tbody tr").filter({ hasText: NAME });
      await expect(reg).toContainText("₹28,560", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });
});
