/**
 * Card test — R-2625 "Balance Sheet (management view): Advance billing" + "P&L Management: no revenue
 * for months that have not happened".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2625`.
 *
 * Data: `node scripts/dev/r2624-revenue-matched.mjs` (run here in beforeAll; local docker DB only)
 * adds invoice R2624-YEARLY dated 1 Oct 2026, a yearly Google Workspace line, ₹12,000 + GST.
 * Needs the R-2624 migration on the local DB (`npm run localhost:update`).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, pageAs } from "./card-steps";

const PROD = path.resolve(__dirname, "..", "..");

test.describe("R-2625 Advance billing + no revenue for months not yet happened", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    const r = spawnSync(process.execPath, [path.join(PROD, "scripts", "dev", "r2624-revenue-matched.mjs")], { cwd: PROD, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`R-2624 data script failed: ${(r.stderr || r.stdout).trim()}`);
  });

  test("Step 1: Balance Sheet — statutory sheet balanced as before; below it the Management view card shows Advance billing and still balances", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.goto("/accounting/balance-sheet");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Balance Sheet" })).toBeVisible({ timeout: 60_000 });
    /* the statutory sheet's own balance line — the Management card below has a "Balanced:" line too (its <p>, not a <span>) */
    await expect(page.locator("span", { hasText: /^Balanced: Assets/ })).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("advance-billing-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText("Advance billing (unearned revenue)");
    await expect(card).toContainText("statutory (GST) one");
    const balanced = await card.getByTestId("advance-billing-balanced").innerText();
    const m = /Assets (\(?₹[\d,]+\)?) = Liabilities \+ Equity (\(?₹[\d,]+\)?)/.exec(balanced);
    expect(m, balanced).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    await page.context().close();
  });

  test("Step 2: P&L This FY — Management says revenue is counted only up to the end of this month; As invoiced (GST) has no such note", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.goto("/accounting/pnl");
    await expect(page.getByRole("heading", { name: /P&L Report/ })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "This FY" }).click();
    const mgmt = page.getByRole("group", { name: "View" }).getByRole("button", { name: "Management (matched)" });
    await mgmt.click();
    await expect(mgmt).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pnl-not-yet-earned")).toContainText(/Management revenue is counted only up to the end of this month/, { timeout: 60_000 });
    await expect(page.getByTestId("pnl-not-yet-earned")).toContainText(/not earned yet — it is part of the Advance billing on the Balance Sheet/);
    const gst = page.getByRole("group", { name: "View" }).getByRole("button", { name: "As invoiced (GST)" });
    await gst.click();
    await expect(gst).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pnl-not-yet-earned")).toHaveCount(0, { timeout: 60_000 });
    await page.context().close();
  });
});
