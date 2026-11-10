/**
 * Card test — R-2652: when Zoho refuses every read (429 / daily limit), the FY "Read from Zoho"
 * dialogs stop after 3 tries and say plainly "Zoho's daily limit is reached — try again after
 * 12:00 am IST on <date>; nothing was changed", with a Try again button (no silent retry for ever).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2652`.
 *
 * Zoho is NEVER called: the page's own request to the import route is answered by the test with
 * "busy" (what the route says when Zoho answers 429), and the browser clock is moved on past the
 * one-minute waits. Nothing is saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const BUSY = { ok: true, listed: 0, detailed: 0, complete: false, busy: true };

/** Answer the dialog's preview with "nothing read yet" and every read with Zoho busy; count the reads. */
async function zohoRefusesEverything(page: Page, route: string): Promise<{ reads: () => number }> {
  let reads = 0;
  await page.route(`**${route}`, async (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { action?: string };
    if (body.action === "read") { reads++; return r.fulfill({ json: BUSY }); }
    if (body.action === "restart") return r.fulfill({ json: { ok: true } });
    return r.fulfill({ status: 500, json: { ok: false, error: "Nothing read from Zoho yet." } });
  });
  return { reads: () => reads };
}

/** Move the page's clock past the one-minute waits until the limit notice shows. */
async function waitOutBusy(page: Page) {
  const notice = page.getByTestId("zoho-limit-notice");
  for (let i = 0; i < 6 && !(await notice.isVisible()); i++) {
    await page.clock.runFor(70_000);
    await page.waitForTimeout(500);
  }
  return notice;
}

test.describe("R-2652 — Zoho's limit said plainly in the FY Read from Zoho dialogs", () => {
  onlyInCardTests();

  test("Step 1: Invoices → FY 2025-26 sales from Zoho → Read from Zoho with Zoho refusing → limit box after 3 tries", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.clock.install();
    const z = await zohoRefusesEverything(page, "/api/integrations/zoho-books/sales-import");
    await openAppPage(page, "/invoices");
    await page.getByRole("button", { name: "FY 2025-26 sales from Zoho" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: /Read from Zoho/ }).click();
    const notice = await waitOutBusy(page);
    await expect(notice).toContainText("Zoho's daily limit is reached");
    await expect(notice).toContainText(/Try again after 12:00 am IST on \d+ \w{3} \d{4}/);
    await expect(notice).toContainText("Nothing was changed");
    await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(z.reads()).toBe(3);
    /* Stopped: no more reads on its own. */
    await page.clock.runFor(180_000);
    await page.waitForTimeout(500);
    expect(z.reads()).toBe(3);
  });

  test("Step 2: Expenses → FY 2025-26 from Zoho → same box after 3 refused tries", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.clock.install();
    const z = await zohoRefusesEverything(page, "/api/integrations/zoho-books/purchase-import");
    await openAppPage(page, "/accounting/expenses");
    await page.getByRole("button", { name: "FY 2025-26 from Zoho" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: /Read from Zoho/ }).click();
    const notice = await waitOutBusy(page);
    await expect(notice).toContainText("Zoho's daily limit is reached");
    expect(z.reads()).toBe(3);
  });

  test("Step 3: Bank → Reconcile from Zoho sheet", async () => {
    test.skip(true, "Needs a bank account with open money-in lines and a connected Zoho; the same busy-streak rule is proven by unit tests (zoho-limit.test.ts).");
  });
});
