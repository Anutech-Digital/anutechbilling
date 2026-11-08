/**
 * Card test — R-2562 "Projects ka 'paisa baaki' read apni galti chhupa leta hai".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2562`.
 *
 * How the read is made to fail: Playwright's own `page.route` answers the browser's project-receivables
 * request (GET …/rest/v1/project_milestones, select total_amount, NOT filtered by project_id — the
 * customer page's per-company read is left alone) with a PostgREST-style 500. Nothing in the app is
 * changed for the test — no flag, no test-only route — and the local DB is not touched.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs, toCollectFigure } from "./card-steps";

/** Fail the project-receivables read until `restore()` is called. Returns how many requests it failed. */
async function failProjectReceivables(page: Page): Promise<{ failed: () => number; restore: () => Promise<void> }> {
  let n = 0;
  const match = (url: URL) =>
    url.pathname.endsWith("/rest/v1/project_milestones") &&
    // Exactly the receivables read (readProjectReceivablesByCustomer): this column list, paged by id,
    // no project filter — the Record-receipt list (project-receipts.ts) and per-company reads differ.
    (url.searchParams.get("select") ?? "").replace(/\s/g, "") === "project_id,total_amount,invoice_id" &&
    (url.searchParams.get("order") ?? "").startsWith("id") &&
    !url.searchParams.has("project_id");
  const handler = async (route: Route) => {
    n++;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "XX000", message: "R-2562 card test: read made to fail", details: null, hint: null }),
    });
  };
  await page.route(match, handler);
  return { failed: () => n, restore: () => page.unroute(match, handler) };
}

test.describe("R-2562 — a failed project-receivables read shows an error with Try again, never ₹0", () => {
  onlyInCardTests();

  test("Step 1: Companies › Has receivables — To collect shows '—' and the line says 'Project invoices couldn't be read' with Try again", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const fail = await failProjectReceivables(page);
      await openAppPage(page, "/customers?view=unpaid");
      const unread = page.getByTestId("to-collect-unread");
      await expect(unread).toBeVisible({ timeout: 90_000 });
      await expect(unread).toContainText("Project invoices couldn't be read");
      await expect(unread.getByRole("button", { name: "Try again" })).toBeVisible();
      // The To collect tile (open strip) or its closed-strip fact says "—", not a ₹ figure
      // (R-2569: the shared toCollectFigure — never the table's "To collect" sort header).
      const tile = await toCollectFigure(page);
      await expect(tile).toContainText("—");
      await expect(tile).not.toContainText("₹");
      expect(fail.failed(), "the project read was made to fail").toBeGreaterThan(0);

      // Try again with the read working again → the error goes and the tile shows a ₹ figure.
      await fail.restore();
      await unread.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByTestId("to-collect-unread")).toHaveCount(0, { timeout: 60_000 });
      await expect(await toCollectFigure(page)).toContainText("₹", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Renewals — the line under the title says 'Project invoices couldn't be read' with Try again (no Companies total)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await failProjectReceivables(page);
      await openAppPage(page, "/renewals", /^Renewals$/);
      const line = page.getByTestId("renewals-dues-line");
      await expect(line).toContainText("Project invoices couldn't be read", { timeout: 90_000 });
      await expect(line).not.toContainText("Has receivables");
      // The Try again sits right after the line, in the same header paragraph.
      await expect(line.locator("xpath=..").getByRole("button", { name: "Try again" })).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Dashboard — the Collections card says 'Didn't load' with Try again, not '₹X to collect'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await failProjectReceivables(page);
      await openAppPage(page, "/dashboard");
      // The Collections card itself (its "Collections" pill and body) — not some other card's error.
      const card = page.getByText("Collections", { exact: true }).first()
        .locator("xpath=ancestor::div[contains(@class,'space-y-1')][1]");
      const alert = card.getByRole("alert");
      await expect(alert).toContainText("Didn't load", { timeout: 90_000 });
      await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /^₹[\d,]+ to collect$/ })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
