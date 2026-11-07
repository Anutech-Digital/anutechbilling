/**
 * Card test — R-2556 "Desk Record payment: default TDS on the whole quote, also on the second half" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2556`.
 *
 * Data: scenario "approved-quote" (R-2458) — Q-SCN-AP-2, accepted, ₹12,744 incl 18% GST (taxable ₹10,800).
 * The spec reloads that scenario before it starts and again when it ends (scripts/dev/scenario.mjs —
 * local docker DB only, it refuses anything else), so the half payment it records is not left behind.
 *
 * Expected: half paid (₹6,372, no TDS) → Record payment again, TDS 2% → the TDS is on THIS payment's
 * part: ₹6,372 × 10,800 ÷ 12,744 = ₹5,400 taxable → ₹108 — not 2% of the whole ₹10,800 (₹216).
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const QUOTE = "Q-SCN-AP-2";

function reloadScenario() {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", "approved-quote", "--reset"], { stdio: "pipe", timeout: 120_000 });
}

/** Open Record payment on the quote (?pay=1 opens the sheet with the balance filled). */
async function openRecordPayment(page: Page) {
  await openAppPage(page, `/quotes/${QUOTE}?pay=1`);
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("#amount")).toBeVisible({ timeout: 60_000 });
  return sheet;
}

test.describe("R-2556 — default TDS only on this payment's part", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => reloadScenario());
  test.afterAll(() => reloadScenario());

  test("Step 1: Owner records half of Q-SCN-AP-2 (₹6,372 of ₹12,744, no TDS)", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const sheet = await openRecordPayment(page);
      await sheet.locator("#amount").fill("6372");
      await sheet.getByRole("button", { name: "Confirm payment" }).click();
      await expect(sheet).toBeHidden({ timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Record payment again on the same quote — it opens for the remaining ₹6,372", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const sheet = await openRecordPayment(page);
      await expect(sheet.getByText("Record additional payment")).toBeVisible();
      await expect(sheet.locator("#amount")).toHaveValue("6372");
      await sheet.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: tick TDS at 2% → TDS on the remaining half only (₹108 on ₹5,400, not ₹216)", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const sheet = await openRecordPayment(page);
      await sheet.getByText("Customer deducted TDS", { exact: true }).click();
      await sheet.locator("#tdsRatePct").fill("2");
      await expect(sheet.getByTestId("tds-part-taxable")).toContainText("₹5,400");
      const tdsRow = sheet.locator("div.text-rose").filter({ hasText: "TDS @ 2%" });
      await expect(tdsRow).toContainText("₹108");
      await expect(tdsRow).not.toContainText("₹216");
      await expect(sheet.locator("#amount")).toHaveValue("6264");
      // Not saved — the sheet is closed; afterAll reloads the scenario.
      await sheet.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });
});
