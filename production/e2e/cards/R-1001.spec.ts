/**
 * Card test — R-1001 "Data leak: employee data visible to every role" (R-2550).
 *
 * One test per howToCheck step of the card (titles start "Step N"), on the LOCAL app
 * (E2E Test Co) through the Local test login. Run: `node scripts/ops/card-tests.mjs R-1001`.
 *
 * What a machine can check is checked; the rest is a test.skip with the reason, so the result
 * says exactly what was NOT proven:
 *   - Step 4 (kiosk PIN + selfie) needs a camera and the office network — a person checks it.
 *   - PAN / labour cost: the local company has no PAN filled and no labour allocated (7 Nov), so
 *     those parts are noted, not faked.
 *   - Billing: the Local test login has no billing button, so step 5 checks the menu RULE the
 *     sidebar is built from (src/lib/nav.ts), not a billing browser session.
 */
import { expect, test, type Browser } from "@playwright/test";
import { filterNavForRole, flattenNav, isRouteAllowed, APP_NAV } from "../../src/lib/nav";
import { onlyInCardTests, openAppPage, pageAs, pathOf } from "./card-steps";

/** Employee names the OWNER sees on /accounting/employees — read once, used by the Sales steps. */
let ownerNames: Promise<string[]> | null = null;
function employeeNamesAsOwner(browser: Browser, baseURL: string | undefined): Promise<string[]> {
  if (!ownerNames) {
    ownerNames = (async () => {
      const page = await pageAs(browser, baseURL, "owner");
      try {
        await openAppPage(page, "/accounting/employees", /^Employees$/);
        const names = page.locator("tbody tr td:first-child .font-medium");
        await expect(names.first()).toBeVisible({ timeout: 60_000 });
        return (await names.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
      } finally {
        await page.context().close();
      }
    })();
    ownerNames.catch(() => { ownerNames = null; });
  }
  return ownerNames;
}

test.describe("R-1001 — employee data only for owner / manager / accountant", () => {
  onlyInCardTests();

  test("Step 1a: Owner sees the Employees list with names and salary (Payroll → Employees)", async ({ browser, baseURL }) => {
    const names = await employeeNamesAsOwner(browser, baseURL);
    expect(names.length, "owner should see at least one employee").toBeGreaterThan(0);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /^Employees$/);
      const firstRow = page.locator("tbody tr").first();
      await expect(firstRow).toBeVisible({ timeout: 60_000 });
      // Salary column: at least one row shows a rupee amount (owner may read salary).
      await expect(page.locator("tbody tr td").filter({ hasText: /₹\s?[\d,]+/ }).first()).toBeVisible();
      test.info().annotations.push({ type: "note", description: `${names.length} employees: ${names.join(", ")}. PAN not checked — no PAN filled in the local company.` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 1b: Owner opens Loans & Salary Advances", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/loans", /Employee Loans & Advances/);
      expect(pathOf(page)).toBe("/accounting/loans");
      await expect(page.getByText(/Outstanding \(owed back\)/i).first()).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Sales opens My Attendance and sees only their own name (or a profile list without others)", async ({ browser, baseURL }) => {
    const all = await employeeNamesAsOwner(browser, baseURL);
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/attendance/me", /My Attendance/);
      expect(pathOf(page)).toBe("/attendance/me");
      const picker = page.getByRole("heading", { name: "Select your profile" });
      const checkIn = page.getByRole("button", { name: /^Check In$/ });
      await expect(picker.or(checkIn).first()).toBeVisible({ timeout: 60_000 });
      const text = await page.locator("main").innerText();
      const seen = all.filter((n) => text.includes(n));
      if (await picker.isVisible()) {
        await page.getByRole("combobox").first().click();
        const options = (await page.getByRole("option").allInnerTexts()).map((s) => s.trim());
        await page.keyboard.press("Escape");
        expect(options.length, `'Select your profile' lists ${options.join(", ")}`).toBeLessThan(all.length);
        test.info().annotations.push({ type: "note", description: `Profile list: ${options.join(", ") || "(empty)"}` });
      } else {
        // Already linked: exactly one employee name — their own — on the page.
        expect(seen, `employee names visible to Sales on /attendance/me: ${seen.join(", ")}`).toHaveLength(1);
        test.info().annotations.push({ type: "note", description: `Linked profile: ${seen[0]}. Selfie/camera not checked (machine has no camera).` });
      }
    } finally {
      await page.context().close();
    }
  });

  test("Step 2b: Sales cannot open Employees, Payroll or Loans by URL", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      for (const path of ["/accounting/employees", "/accounting/payroll", "/accounting/loans"]) {
        await page.goto(path);
        await expect(page, `${path} must bounce Sales away`).not.toHaveURL(new RegExp(`${path}$`), { timeout: 60_000 });
        await expect(page).not.toHaveURL(/\/login/);
      }
    } finally {
      await page.context().close();
    }
  });

  test("Step 3a: Sales — Contacts shows no employees", async ({ browser, baseURL }) => {
    const all = await employeeNamesAsOwner(browser, baseURL);
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/contacts", /^Contacts$/);
      await expect(page.getByText(/Showing \d+ of \d+ people/)).toBeVisible({ timeout: 60_000 });
      const text = await page.locator("main").innerText();
      const leaked = all.filter((n) => text.includes(n));
      expect(leaked, `employee names on Sales' Contacts page: ${leaked.join(", ")}`).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3b: Sales — Project Sales opens; labour cost (salary) not shown", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/projects", /^Project Sales$/);
      await expect(page.getByText(/labour/i)).toHaveCount(0);
      test.info().annotations.push({ type: "note", description: "No labour is allocated on any local project, so 'blank' is not a strong proof — add labour via a scenario to make it one." });
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Kiosk — every employee name, PIN + selfie check-in", async () => {
    test.skip(true, "Machine can't: the kiosk needs a camera (selfie) and the office network — a person checks this on the device.");
  });

  test("Step 5: Billing — Payroll / Loans not in the menu (menu rule)", async () => {
    // No billing button in the Local test login, so this checks the rule the sidebar and the
    // route guard are built from — the same functions the app calls for a billing user.
    const billingMenu = flattenNav(filterNavForRole(APP_NAV, "billing")).map((e) => e.item.href);
    for (const href of ["/accounting/payroll", "/accounting/loans", "/accounting/employees", "/accounting/salary-register"]) {
      expect(billingMenu, `${href} in billing's menu`).not.toContain(href);
      expect(isRouteAllowed("billing", href), `billing may open ${href}`).toBe(false);
    }
    test.info().annotations.push({ type: "note", description: "Checked the menu rule (nav.ts), not a billing browser session — the Local test login has no billing button." });
  });
});
