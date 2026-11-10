/**
 * Card test — R-2567 "project-receipts.ts: milestone read ki galti chhup jaati hai + Companies par
 * do 'Try again' button".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2567`.
 *
 * How the read is made to fail: Playwright's own `page.route` answers the browser's
 * project-receivables request (the same matcher as R-2562's card test) with a PostgREST-style 500.
 * Nothing in the app is changed for the test — no flag, no test-only route — and the local DB is
 * not touched.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs, toCollectFigure } from "./card-steps";

async function failProjectReceivables(page: Page): Promise<{ failed: () => number; restore: () => Promise<void> }> {
  let n = 0;
  const match = (url: URL) =>
    url.pathname.endsWith("/rest/v1/project_milestones") &&
    (url.searchParams.get("select") ?? "").replace(/\s/g, "") === "project_id,total_amount,invoice_id" &&
    (url.searchParams.get("order") ?? "").startsWith("id") &&
    !url.searchParams.has("project_id");
  const handler = async (route: Route) => {
    n++;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "XX000", message: "R-2567 card test: read made to fail", details: null, hint: null }),
    });
  };
  await page.route(match, handler);
  return { failed: () => n, restore: () => page.unroute(match, handler) };
}

test.describe("R-2567 — one Try again for a failed project read; booking never raises an invoice blind", () => {
  onlyInCardTests();

  test("Step 1: Companies › Has receivables — project invoices read fails → '—', the line names it, and exactly ONE Try again on the page", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const fail = await failProjectReceivables(page);
      await openAppPage(page, "/customers?view=unpaid");
      const unread = page.getByTestId("to-collect-unread");
      await expect(unread).toBeVisible({ timeout: 90_000 });
      await expect(unread).toContainText("Project invoices couldn't be read");
      const tile = await toCollectFigure(page);
      await expect(tile).toContainText("—");
      await expect(tile).not.toContainText("₹");
      // One failure, one button: the generic money banner does not add a second Try again.
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
      await expect(unread.getByRole("button", { name: "Try again" })).toBeVisible();
      expect(fail.failed(), "the project read was made to fail").toBeGreaterThan(0);

      await fail.restore();
      await unread.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByTestId("to-collect-unread")).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await expect(await toCollectFigure(page)).toContainText("₹", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Banking › reconcile a receipt as a project payment with a failed milestone check — no invoice raised blind", async () => {
    test.skip(true, "Booking a bank receipt writes a payment + reconcile into the local books (no test data may stay). "
      + "Covered by src/lib/queries/project-receipts-read-errors-r2567.test.ts: a failed milestone read raises no invoice "
      + "and the toast says 'Payment booked, but this instalment's invoice couldn't be checked'.");
  });
});
