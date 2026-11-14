/**
 * Card test — R-2713 (Pratik): the Help "error caught" alert names the page and the time, so an error
 * from an earlier page is not taken for this page's. Run: `node scripts/ops/card-tests.mjs R-2713`.
 *
 * No data is written: the error is one harmless failed request (GET /api/r2713-missing → 404) made on
 * the Quotes page; the test then moves to Customers inside the app and reads the alert there.
 * (Part 1 of the card — Starts on the quote line — landed with R-2727 and is checked by its spec.)
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const STAMP = /\d{2}:\d{2} [ap]m/;

async function helpButton(page: Page) {
  return page.locator('[data-topbar="help"]').filter({ visible: true }).first();
}

test.describe("R-2713 Help error alert says where and when", () => {
  onlyInCardTests();

  test("an error on Quotes still says 'Error on /quotes at <time>' after moving to Customers; Dismiss clears it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/quotes", /Quotes/);
      await page.evaluate(() => fetch("/api/r2713-missing").catch(() => undefined));

      const btn = await helpButton(page);
      await expect(btn).toHaveAttribute("aria-label", /^Help — an error was caught/, { timeout: 15_000 });
      const title = await btn.getAttribute("title");
      expect(title ?? "").toMatch(new RegExp(`^Error on /quotes at ${STAMP.source}: `));

      /* Move inside the app like the owner — the menu's Companies link (same tab: the alert lives in this tab's trail). */
      await page.getByRole("complementary").getByRole("link", { name: "Companies", exact: true }).click();
      await expect(page).toHaveURL(/\/customers/, { timeout: 120_000 });
      await expect(btn).toHaveAttribute("title", /^Error on \/quotes at /);

      /* The red Help button opens on "Report a problem" — the caught error there names page + time. */
      await btn.click();
      await expect(page.getByText(new RegExp(`^Error on /quotes at ${STAMP.source}: .* — it goes with this report`))).toBeVisible();
      await page.getByRole("tab", { name: /^Ask$/ }).click();
      const banner = page.getByText(new RegExp(`^Error on /quotes at ${STAMP.source}$`));
      await expect(banner).toBeVisible();
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect(banner).toHaveCount(0);
      await expect(btn).toHaveAttribute("aria-label", /^Help — ask AI/);
    } finally {
      await page.context().close();
    }
  });
});
