/**
 * Card test — R-2870: after a "Bill together" renewal quote (R-2847..R-2849) is paid IN FULL, each renewed row's Last bill
 * shows the together invoice and its payment (not "No payment yet"), and "Renewed this month" counts each member.
 * Run: `node scripts/ops/card-tests.mjs R-2870`. Reuses R-2850's scenario "yearly-together" (E2E Test Co, local docker DB only):
 * SCN Yearly Pair Pvt Ltd, two yearly subscriptions renewing in 10 and 20 days; ₹21,600 + ₹16,320 + GST once = ₹44,746.
 * Every money step is pressed in the app (Bill together, Record payment) — SQL only reads.
 * NOTE: the localhost server runs reselleros-deploy's build; this passes only once that build contains the R-2870 code.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const SUB_A = "c2850000-0000-4000-8000-000000000021";
const NAME = "SCN Yearly Pair Pvt Ltd";
const PLAN_A = "SCN Yearly Standard";
const PLAN_B = "SCN Yearly Starter";
const TOTAL = 44746;
const db = () => localDb("R-2870");
const T = E2E_TENANT_SQL;

const scenario = (flag: "--reset" | "--clear"): void => {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", "yearly-together", flag], { stdio: "pipe", timeout: 180_000 });
};
const rowOf = (page: Page, plan: string): Locator =>
  page.getByTestId("renewal-row").filter({ hasText: NAME }).filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) });
const tile = (page: Page): Locator => page.locator("button").filter({ has: page.getByTestId("renewal-tile-caption-renewedMonth") });
/** "N renewals" printed on the Renewed this month tile. */
async function renewedCount(page: Page): Promise<number> {
  await expect(tile(page)).toContainText(/\d+ renewals?/, { timeout: 120_000 });
  return Number(/(\d+) renewals?/.exec(await tile(page).innerText())![1]);
}

test.describe("R-2870 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => { if (CARD_TESTS_ON) scenario("--reset"); });
  test.afterAll(() => { if (CARD_TESTS_ON) scenario("--clear"); });

  test("Bill together, pay in full → both rows' Last bill shows the one paid invoice, and Renewed this month counts both", async ({ browser, baseURL }) => {
    test.setTimeout(900_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
      await expect(rowOf(page, PLAN_A)).toHaveCount(1, { timeout: 120_000 });
      const before = await renewedCount(page);

      /* Bill together → one renewal quote */
      const btn = (await onlyOne(page.getByTestId("bill-together-group").filter({ hasText: NAME }), "the Bill together box", 120_000)).getByRole("button", { name: /Bill together/ });
      await btn.click();
      const dlg = page.getByRole("dialog");
      await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
      const create = dlg.getByRole("button", { name: "Create renewal quote" });
      await expect(create).toBeEnabled({ timeout: 60_000 });
      await create.click();
      await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 120_000 });
      const quoteId = db().one(`select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_A}' and s.tenant_id = ${T}`);

      /* pay it in full (the sheet offers the whole ₹44,746) */
      await openAppPage(page, `/quotes/${encodeURIComponent(quoteId)}?pay=1`);
      const sheet = page.getByRole("dialog", { name: "Record payment received" });
      await expect(sheet.locator("#amount")).toHaveValue(String(TOTAL), { timeout: 90_000 });
      await sheet.getByRole("button", { name: "Confirm payment" }).click();
      await expect(sheet).toBeHidden({ timeout: 120_000 });
      const invoice = db().one(`select i.id from public.invoices i where i.quote_id = '${quoteId}' and i.tenant_id = ${T}`);
      expect(invoice).toBeTruthy();

      /* Renewals "Later" (they are renewed, dated a year on): Last bill = the together invoice, paid, with its payment */
      await openAppPage(page, "/renewals?bucket=later", /Renewals/);
      await expect(page.getByTestId("renewal-row").first()).toBeVisible({ timeout: 120_000 });
      await page.getByPlaceholder("Search customer or domain").fill("SCN Yearly Pair");
      for (const plan of [PLAN_A, PLAN_B]) {
        const cell = (await onlyOne(rowOf(page, plan), `the ${plan} row`, 90_000)).getByTestId("renewal-last-invoice-cell");
        await expect(cell).toContainText(invoice, { timeout: 90_000 });
        await expect(cell).toContainText("Paid");
        await expect(cell).not.toContainText("No payment yet");
        await expect(rowOf(page, plan).getByTestId("renewal-row-last-paid")).toContainText("Paid", { timeout: 60_000 });
        await expect(rowOf(page, plan).getByTestId("renewal-row-last-paid")).not.toContainText("No payment yet");
      }

      /* the tile counts both members (each its own share) */
      await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
      expect(await renewedCount(page), "Renewed this month: +2 (one per renewed subscription)").toBe(before + 2);
    } finally {
      await page.context().close();
    }
  });
});
