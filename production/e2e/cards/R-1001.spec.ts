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
 *   - Billing (R-2553): step 5 signs in with the local Billing test login in the browser; the
 *     "Reimbursements: employee name may be blank" part is a judgement, noted, not tested.
 */
import { expect, test, type Browser } from "@playwright/test";
import { namesShown, onlyInCardTests, openAppPage, pageAs, pathOf } from "./card-steps";

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
      // Three right answers for Sales (R-1414): linked → own name + Check In; not linked → the
      // "Profile not linked" card (ask the owner). "Select your profile" is only for owner /
      // manager / accountant (canPickEmployee) — Sales seeing it would itself be a leak.
      const picker = page.getByRole("heading", { name: "Select your profile" });
      const notLinked = page.getByRole("heading", { name: "Profile not linked" });
      const checkIn = page.getByRole("button", { name: /^Check In$/ });
      await expect(picker.or(notLinked).or(checkIn).first()).toBeVisible({ timeout: 60_000 });
      await expect(picker, "Sales must not get the 'Select your profile' list of employees").toHaveCount(0);
      const seen = await namesShown(page, all);
      if (await notLinked.isVisible()) {
        expect(seen, `employee names visible to an unlinked Sales user: ${seen.join(", ")}`).toEqual([]);
        test.info().annotations.push({ type: "note", description: "Sales is not linked to an employee: 'Profile not linked' card, no names shown." });
      } else {
        // Linked: exactly one employee name — their own — on the page.
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
      const showing = page.getByText(/Showing \d+ of \d+ people/);
      await expect(showing).toBeVisible({ timeout: 60_000 });
      // The check reads one page; it is only a proof when that page holds every contact.
      const [, shown, total] = /Showing (\d+) of (\d+)/.exec(await showing.innerText()) ?? [];
      expect(shown, `Contacts shows ${shown} of ${total} — the list is paged, this step must search instead`).toBe(total);
      const leaked = await namesShown(page, all);
      expect(leaked, `employee names on Sales' Contacts page: ${leaked.join(", ")}`).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3b: Sales — Project Sales opens; labour cost (salary) not shown", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/projects", /^Project Sales$/);
      // Wait for the project cards themselves, so "no labour" is judged on loaded data.
      await expect(page.getByText(/Contract \(incl GST\)|No projects/i).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("main").getByText(/labour/i)).toHaveCount(0);
      test.info().annotations.push({ type: "note", description: "No labour is allocated on any local project, so 'blank' is not a strong proof — add labour via a scenario to make it one." });
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Kiosk — every employee name, PIN + selfie check-in", async () => {
    test.skip(true, "Machine can't: the kiosk needs a camera (selfie) and the office network — a person checks this on the device.");
  });

  test("Step 5: Billing — Payroll / Loans not in the menu, and bounced by URL (browser login)", async ({ browser, baseURL }) => {
    const blocked = ["/accounting/payroll", "/accounting/loans", "/accounting/employees", "/accounting/salary-register"];
    const page = await pageAs(browser, baseURL, "billing");
    try {
      // Billing's menu: wait until the sidebar has drawn Billing's own Invoices link, so
      // "no Payroll link" is judged on a loaded menu, not an empty one. A closed accordion does not
      // draw its children (Loans / Salary Register sit under Payroll), so the URL check below is
      // the proof for those; this one proves the top-level rows.
      await openAppPage(page, "/invoices");
      await expect(page.locator('a[href="/invoices"]').first()).toBeVisible({ timeout: 60_000 });
      for (const href of blocked) {
        await expect(page.locator(`a[href="${href}"]`), `${href} link in Billing's menu`).toHaveCount(0);
      }
      // By URL: every payroll page sends Billing elsewhere, still signed in.
      for (const path of blocked) {
        await page.goto(path);
        await expect(page, `${path} must bounce Billing away`).not.toHaveURL(new RegExp(`${path}$`), { timeout: 60_000 });
        await expect(page).not.toHaveURL(/\/login/);
      }
      test.info().annotations.push({ type: "note", description: `Billing (browser login): no menu link and bounced by URL for ${blocked.join(", ")}. Reimbursements' blank employee name not judged (a decision, not a test).` });
    } finally {
      await page.context().close();
    }
  });
});
