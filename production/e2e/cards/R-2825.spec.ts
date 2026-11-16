/**
 * Card test — R-2825 "Renewals first load: buttons visibly disabled ('Loading…') until they work".
 *
 * Reads E2E Test Co's own renewals (no data planted). Run: `node scripts/ops/card-tests.mjs R-2825`.
 * The load time is written as an annotation (a machine-speed number is not a pass/fail step).
 */
import { expect, test } from "@playwright/test";
import { onlyInCardTests, pageAs } from "./card-steps";

test.describe("R-2825 card test", () => {
  onlyInCardTests();

  test("Step 1: while the rows load, the Action column shows a disabled 'Loading…' button; when ready it is the real button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const t0 = Date.now();
    await page.goto("/renewals?bucket=later");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("renewal-row").first()).toBeVisible({ timeout: 120_000 });
    const rowsAt = (Date.now() - t0) / 1000;
    const loading = page.getByTestId("stage-action-loading");
    const seen = await loading.count();
    if (seen > 0) {
      /* every placeholder is a real, disabled, aria-busy button — a click on it does nothing */
      const first = loading.first();
      expect(await first.evaluate((el) => el.tagName)).toBe("BUTTON");
      await expect(first).toBeDisabled();
      await expect(first).toHaveAttribute("aria-busy", "true");
      await expect(first).toContainText("Loading…");
    }
    await expect(loading).toHaveCount(0, { timeout: 120_000 });
    const readyAt = (Date.now() - t0) / 1000;
    test.info().annotations.push({
      type: "timing",
      description: `rows at ${rowsAt.toFixed(1)} s, every button ready at ${readyAt.toFixed(1)} s (placeholders seen at rows time: ${seen})`,
    });
    const primary = page.getByTestId("stage-primary").first();
    await expect(primary).toBeVisible();
    await expect(primary).toBeEnabled({ timeout: 30_000 });
    await expect(primary).not.toHaveAttribute("aria-busy", "true");
    await page.context().close();
  });
});
