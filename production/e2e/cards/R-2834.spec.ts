/**
 * Card test — R-2834 "Renewals drawer 'Renews' line shows the anchor date / part due like the row;
 * Due cell tooltip shows both dates".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2834`.
 *
 * Reads the Overdue tab's Greentin Check 2095 row (part due 1 Oct, renews 31 Oct — the R-2817 example)
 * — writes no data. Skipped when that row is not in the local company.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const BOTH = "Part due 1 Oct 2026 · renews 31 Oct 2026";

let shared: Page | null = null;
async function greentinRow(browser: Browser, baseURL: string | undefined, width: number): Promise<{ page: Page; row: Locator | null }> {
  if (!shared) shared = await pageAs(browser, baseURL, "owner");
  /* 1280 laptop and its 1276 inner width (sidebar open) */
  await shared.setViewportSize({ width, height: 900 });
  await openAppPage(shared, "/renewals?bucket=overdue", /Renewals/);
  const table = shared.getByTestId("renewals-table");
  await expect(table.getByTestId("renewal-row").first()).toBeVisible({ timeout: 90_000 });
  await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
  const row = table.getByTestId("renewal-row").filter({ hasText: "Greentin Check 2095" }).filter({ has: shared.locator('[data-cell="due"]', { hasText: "1 Oct 26" }) });
  return { page: shared, row: (await row.count()) ? row.first() : null };
}

test.describe("R-2834 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  for (const width of [1280, 1276]) {
    test(`Step 1 (${width}): hovering the Due date names both dates`, async ({ browser, baseURL }) => {
      const { row } = await greentinRow(browser, baseURL, width);
      test.skip(!row, "Greentin Check 2095 with a part due 1 Oct is not in the local company");
      const date = row!.locator('[data-cell="due"] p').first();
      await expect(date).toHaveText("1 Oct 26");
      /* the date's nearest tooltip — what the browser shows on hover */
      const hover = await date.evaluate((el) => el.closest("[title]")?.getAttribute("title") ?? null);
      expect(hover).toBe(BOTH);
    });

    test(`Step 2 (${width}): the drawer's date line reads the same two dates`, async ({ browser, baseURL }) => {
      const { page, row } = await greentinRow(browser, baseURL, width);
      test.skip(!row, "Greentin Check 2095 with a part due 1 Oct is not in the local company");
      await row!.getByTestId("renewal-open-drawer").click();
      const drawer = page.getByTestId("renewal-drawer");
      await expect(drawer).toBeVisible({ timeout: 60_000 });
      await expect(drawer.getByTestId("renewal-drawer-renews")).toHaveText(BOTH, { timeout: 60_000 });
      const spill = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
    });
  }
});
