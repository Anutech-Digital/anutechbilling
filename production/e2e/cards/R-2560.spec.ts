/**
 * Card test — R-2560 "Desk Record payment: first payment with a smaller bank amount still took TDS on
 * the whole balance" (R-2550 card test; follow-up of R-2556).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2560`.
 *
 * Data: scenario "approved-quote" (R-2458) — Q-SCN-AP-2, accepted, nothing paid, ₹12,744 incl 18% GST
 * (taxable ₹10,800). Nothing is saved (every sheet is cancelled); the scenario is reloaded before and
 * after anyway (scripts/dev/scenario.mjs — local docker DB only, it refuses anything else).
 *
 * Expected: TDS 2%, bank typed ₹6,000 (less than the ₹12,744 balance) → the part is money + TDS =
 * ₹6,103 → taxable ₹5,172 → TDS ₹103 — not 2% of the whole ₹10,800 (₹216). The bank amount typed stays.
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

test.describe("R-2560 — default TDS follows the bank amount typed on the first payment", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => reloadScenario());
  test.afterAll(() => reloadScenario());

  test("Step 1: Owner opens Record payment on an approved quote (Q-SCN-AP-2, ₹12,744 balance)", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const sheet = await openRecordPayment(page);
      await expect(sheet.locator("#amount")).toHaveValue("12744");
      await sheet.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });

  test("Step 2+3: TDS 2%, bank amount typed less than the balance (₹6,000) → TDS ₹103 on that part, not ₹216; Net to bank ₹6,000", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const sheet = await openRecordPayment(page);
      await sheet.getByText("Customer deducted TDS", { exact: true }).click();
      await sheet.locator("#tdsRatePct").fill("2");
      const tdsRow = sheet.locator("div.text-rose").filter({ hasText: "TDS @ 2%" });
      // Full balance first: the whole TDS, as before.
      await expect(tdsRow).toContainText("₹216");
      await sheet.locator("#amount").fill("6000");
      await expect(tdsRow).toContainText("₹103");
      await expect(tdsRow).not.toContainText("₹216");
      await expect(sheet.getByTestId("tds-part-taxable")).toContainText("₹5,172");
      await expect(sheet.locator("#amount")).toHaveValue("6000");
      await expect(sheet.getByText("Net to your bank", { exact: true }).locator("..")).toContainText("₹6,000");
      // Not saved — the sheet is closed; afterAll reloads the scenario.
      await sheet.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });
});
