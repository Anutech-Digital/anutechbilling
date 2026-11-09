/**
 * Card test — R-2624 "P&L Management view: prepaid yearly revenue spread over its months".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2624`.
 *
 * Data: `node scripts/dev/r2624-revenue-matched.mjs` (run here in beforeAll; local docker DB only)
 * adds invoice R2624-YEARLY dated 1 Oct 2026, a yearly Google Workspace line, ₹12,000 + GST.
 * Needs the R-2624 migration on the local DB (`npm run localhost:update`).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, pageAs } from "./card-steps";

const PROD = path.resolve(__dirname, "..", "..");
const INV = "R2624-YEARLY";

async function openPnl(page: Page, from: string, to: string) {
  await page.goto("/accounting/pnl");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /P&L Report/ })).toBeVisible({ timeout: 60_000 });
  await page.locator("#pnl-from").fill(from);
  await page.locator("#pnl-to").fill(to);
}

async function view(page: Page, name: "Management (matched)" | "As invoiced (GST)") {
  const btn = page.getByRole("group", { name: "View" }).getByRole("button", { name });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/** Open the Revenue drill and return it once its tie line is shown (total = card). */
async function revenueDrill(page: Page) {
  /* The first Management load reads the spread revenue + matched COGS — give the statement time to
     render before clicking (10 s default was too short on a cold localhost, 9 Nov). */
  const hint = page.getByRole("button", { name: /invoiced − |earned this period/ }).first();
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await hint.click();
  const d = page.getByRole("dialog");
  const tie = d.getByTestId("pnl-drill-tie");
  await expect(tie).toBeVisible({ timeout: 60_000 });
  await expect(tie).not.toHaveAttribute("role", "alert");   // the red "does not match" note
  await expect(tie).toHaveText(/^Total ₹[\d,]+ = Revenue ₹[\d,]+$/);
  return d;
}

test.describe("R-2624 P&L Management revenue spread", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    const r = spawnSync(process.execPath, [path.join(PROD, "scripts", "dev", "r2624-revenue-matched.mjs")], { cwd: PROD, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`R-2624 data script failed: ${(r.stderr || r.stdout).trim()}`);
  });

  test("Step 1: Owner, October 2026, Management (matched) — the yearly invoice is ₹1,000 for Oct 2026 – Sep 2027; total = card", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2026-10-01", "2026-10-31");
    await view(page, "Management (matched)");
    const d = await revenueDrill(page);
    await expect(d).toContainText("spread over the months it pays for");
    const row = d.getByText(new RegExp(`${INV}.*for Oct 2026 – Sep 2027.*part of ₹12,000 spread over the whole period`));
    await expect(row).toBeVisible();
    await page.context().close();
  });

  test("Step 2: As invoiced (GST), October 2026 — the same invoice is the whole ₹12,000; total = card", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2026-10-01", "2026-10-31");
    await view(page, "As invoiced (GST)");
    const d = await revenueDrill(page);
    await expect(d).toContainText(INV);
    await expect(d).not.toContainText("part of ₹12,000 spread over the whole period");
    await page.context().close();
  });

  /* R-2625: Management counts revenue only up to today — March 2027 has not happened, so the
     invoice's ₹1,000 for March is "not earned yet" (Advance billing), not March revenue. */
  test("Step 3: Management (matched), March 2027 — not earned yet (R-2625): the page says so and the drill has no R2624-YEARLY; GST view has nothing from it either", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2027-03-01", "2027-03-31");
    await view(page, "Management (matched)");
    await expect(page.getByTestId("pnl-not-yet-earned")).toContainText(/already invoiced for the rest of this period is not earned yet/, { timeout: 60_000 });
    const d = await revenueDrill(page);
    await expect(d).not.toContainText(INV);
    await page.keyboard.press("Escape");
    await view(page, "As invoiced (GST)");
    const g = await revenueDrill(page);
    await expect(g).not.toContainText(INV);
    await page.context().close();
  });
});
