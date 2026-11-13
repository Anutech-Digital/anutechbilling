/**
 * Card test — R-2661: Zoho's DAILY API limit is counted per company and the app stops BEFORE it.
 * The FY "Read from Zoho" dialogs show "Zoho calls today: N of 900"; when the day's budget is used
 * the read stops at once with "Zoho calls today: 900 of 900 — the day's budget is used … carries on
 * after 12:00 am IST on <date>" and a Try again button (no 3 silent tries).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2661`.
 *
 * Zoho is NEVER called: step 1 and 3 read the real day-calls route (the local company has made no
 * Zoho call); step 2 answers the dialog's read request with the route's own "day budget used"
 * shape. Nothing is saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { nextIstMidnight } from "../../src/lib/integrations/zoho-books/zoho-limit";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const DAY_LIMIT = { ok: true, listed: 600, detailed: 0, listDone: false, complete: false, busy: true, calls: 0 };

/** Answer every read with "the day's budget is used" (what the route says when the meter refuses); count the reads. */
async function budgetUsed(page: Page, route: string): Promise<{ reads: () => number }> {
  let reads = 0;
  await page.route(`**${route}`, async (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { action?: string };
    if (body.action === "read") {
      reads++;
      return r.fulfill({ json: { ...DAY_LIMIT, dayLimit: { calls: 900, budget: 900, retryAt: nextIstMidnight(Date.now()) } } });
    }
    if (body.action === "restart") return r.fulfill({ json: { ok: true } });
    return r.fulfill({ status: 500, json: { ok: false, error: "Nothing read from Zoho yet." } });
  });
  return { reads: () => reads };
}

test.describe("R-2661 — Zoho calls today + stop before Zoho's daily limit", () => {
  onlyInCardTests();

  test("Step 1: Invoices → FY 2025-26 sales from Zoho → the dialog shows 'Zoho calls today: N of 900' (the real count, 0 on localhost)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/invoices");
    await page.getByRole("button", { name: "FY 2025-26 sales from Zoho" }).click();
    const dlg = page.getByRole("dialog");
    const line = dlg.getByTestId("zoho-day-calls");
    await expect(line).toBeVisible({ timeout: 60_000 });
    await expect(line).toHaveText(/^Zoho calls today: \d[\d,]* of \d[\d,]*/);
  });

  test("Step 2: Read from Zoho with the day's budget used → the budget box at once (one read, no 3 tries), with the IST time and Try again", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const z = await budgetUsed(page, "/api/integrations/zoho-books/sales-import");
    await openAppPage(page, "/invoices");
    await page.getByRole("button", { name: "FY 2025-26 sales from Zoho" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: /Read from Zoho/ }).click();
    const notice = dlg.getByTestId("zoho-limit-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("Zoho's daily limit is reached");
    await expect(notice).toContainText("Zoho calls today: 900 of 900");
    await expect(notice).toContainText(/carries on after 12:00 am IST on \d+ \w{3} \d{4}/);
    await expect(notice).toContainText("Nothing was changed");
    await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(z.reads()).toBe(1);
    /* Stopped: no more reads on its own. */
    await page.waitForTimeout(1_500);
    expect(z.reads()).toBe(1);
  });

  test("Step 3: Expenses → FY 2025-26 from Zoho → the same 'Zoho calls today' line", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/expenses");
    await page.getByRole("button", { name: "FY 2025-26 from Zoho" }).click();
    const dlg = page.getByRole("dialog");
    const line = dlg.getByTestId("zoho-day-calls");
    await expect(line).toBeVisible({ timeout: 60_000 });
    await expect(line).toHaveText(/^Zoho calls today: \d[\d,]* of \d[\d,]*/);
  });
});
