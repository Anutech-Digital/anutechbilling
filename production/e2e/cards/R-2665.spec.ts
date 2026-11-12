/**
 * Card test — R-2665 "Statement import: read HDFC credit-card billed-statement .xls; fix ₹0-balance
 * and unsorted-rows false gaps" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, Owner) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2665`. Nothing is imported — each step reads the
 * Import statement preview and closes it with Cancel, so the local data does not change.
 *
 * File: e2e/fixtures/R-2665-hdfc-card-sample.xls — a MADE-UP statement in HDFC's credit-card
 * "Billed statements" layout (src/lib/testing/fixtures/hdfc-card-statement.ts writes it).
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const SAMPLE = path.resolve(__dirname, "..", "fixtures", "R-2665-hdfc-card-sample.xls");
const BANK = "E2E Bank Current A/c";   // e2e/fixtures/e2e-roles.mjs E2E_BANK_NAME

async function openImport(page: Page) {
  await openAppPage(page, "/accounting/banking");
  await page.getByText(BANK, { exact: true }).first().click();
  await expect(page).toHaveURL(/\/accounting\/banking\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await page.getByRole("button", { name: /^Import statement$/ }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  return dlg;
}

test.describe("R-2665 HDFC credit-card statement + false gaps", () => {
  onlyInCardTests();
  test.setTimeout(180_000);

  test("Step 1: the HDFC card .xls is read — 7 lines, payment as money in, no 'Couldn't parse'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openImport(page);
    await dlg.locator('input[type="file"]').setInputFiles(SAMPLE);
    await expect(dlg.getByText("Parse summary", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(dlg.getByText("Couldn't parse", { exact: true })).toHaveCount(0);
    await expect(dlg.getByText(/7 new to import/)).toBeVisible();
    await expect(dlg.getByText(/AUTOPAY THANK YOU/).first()).toBeVisible();
    await expect(dlg.getByText(/2,00,352/).first()).toBeVisible();
    await expect(dlg.getByText(/are missing/)).toHaveCount(0);
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });

  test("Step 2: a running balance of ₹0 is not a 'missing' gap", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openImport(page);
    await dlg.getByLabel("Or paste CSV text").fill([
      "Date,Narration,Debit,Credit,Balance",
      "01/02/2026,OPENING SPEND,100,,-200352",
      "03/02/2026,FUEL,100,,-200452",
      "03/02/2026,CARD PAYMENT,,200452,0",
    ].join("\n"));
    await expect(dlg.getByText(/Balance chain complete/)).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByText(/are missing/)).toHaveCount(0);
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });

  test("Step 3: lines printed in two date blocks (card style) show no false gap", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openImport(page);
    await dlg.getByLabel("Or paste CSV text").fill([
      "Date,Narration,Debit,Credit,Balance",
      "03/02/2026,CARD PAYMENT,,1500,0",
      "05/02/2026,SHOP,200,,-200",
      "20/01/2026,SAAS INC,1000,,-1000",
      "22/01/2026,MARKUP FEE,500,,-1500",
    ].join("\n"));
    await expect(dlg.getByText(/Balance chain complete/)).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByText(/are missing/)).toHaveCount(0);
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });
});
