/**
 * Card test — R-2764 (R-2742 PERF-1) "Renewals tab click freeze: rows built once, only one layout,
 * 50 rows + Show more, a row's own hooks only when its button / ⋯ is pressed".
 *
 * Reads E2E Test Co's own renewals (no data planted). Run: `node scripts/ops/card-tests.mjs R-2764`.
 * The before/after timing is on the card (perfBefore / perfAfter) — a machine-speed number is not a
 * pass/fail step here.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId("stage-chip").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 90_000 });
}

test.describe("R-2764 card test", () => {
  onlyInCardTests();

  test("Step 1: at 1280 only the table is in the page (no hidden card copy); at 900 only the cards", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=later", /Renewals/);
    await settled(page);
    await expect(page.getByTestId("renewals-table")).toHaveCount(1);
    await expect(page.getByTestId("renewals-cards")).toHaveCount(0);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.getByTestId("renewals-cards")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("renewals-table")).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: a tab lists at most 50 rows; 'Show N more' adds the rest", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=later", /Renewals/);
    await settled(page);
    const rows = page.getByTestId("renewal-row");
    const n = await rows.count();
    expect(n).toBeLessThanOrEqual(50);
    const more = page.getByTestId("renewals-show-more");
    if (n < 50) {
      await expect(more).toHaveCount(0);
      test.info().annotations.push({ type: "note", description: `Later has ${n} rows — no Show more needed` });
    } else if (await more.count()) {
      const total = Number(/of (\d+) shown/.exec(await more.innerText())?.[1]);
      await more.click();
      await expect(rows).toHaveCount(Math.min(total, 100), { timeout: 30_000 });
    }
    await page.context().close();
  });

  test("Step 3: a row's ⋯ item still acts on the FIRST click (its hooks mount then)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=later", /Renewals/);
    await settled(page);
    const dots = page.getByRole("button", { name: /More renewal actions for/ });
    const count = Math.min(await dots.count(), 10);
    /* a menu item that only opens a dialog (nothing is sent or saved) */
    for (let i = 0; i < count; i++) {
      await dots.nth(i).click();
      const item = page.getByRole("menuitem", { name: /^(Bill next part|Customer not renewing)/ }).first();
      if (await item.count()) {
        await item.click();
        await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 30_000 });
        await page.keyboard.press("Escape");
        await page.context().close();
        return;
      }
      await page.keyboard.press("Escape");
    }
    test.skip(true, "no row in Later offers a dialog-only ⋯ item in this data");
  });
});
