/**
 * Card test — R-2662: a password-protected statement PDF is opened in the browser with its
 * password; only its TEXT goes to the AI reader. The password is never in a request.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, account "E2E Test Bank") through
 * the Local test login. Run: `node scripts/ops/card-tests.mjs R-2662`.
 *
 * The PDF is made fresh by the test fixture (RC4-locked, made-up lines, dummy password). The AI
 * route is answered by the test itself (Gemini is never called) and every request body the page
 * sends is recorded and searched for the password. Nothing is imported or saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { encryptedPdf } from "../../src/lib/banking/__fixtures__/encrypted-pdf";

const DUMMY = "dummy-r2662";
const PDF = Buffer.from(encryptedPdf([[
  "DEMO BANK - Statement of account (TEST FILE, made-up data)",
  "Date | Narration | Withdrawal | Deposit | Balance",
  "01/10/2026 | NEFT CR-R2662 DEMO CUSTOMER | | 11800.00 | 61800.00",
  "03/10/2026 | UPI-R2662 DEMO OFFICE SUPPLIES | 1250.00 | | 60550.00",
]], DUMMY));
const ROWS = [
  { txn_date: "2026-10-01", description: "NEFT CR-R2662 DEMO CUSTOMER", debit: 0, credit: 11800, balance_after: 61800, reference: null },
  { txn_date: "2026-10-03", description: "UPI-R2662 DEMO OFFICE SUPPLIES", debit: 1250, credit: 0, balance_after: 60550, reference: null },
];

/** Every request body the page sends, and the AI route answered by the test. */
async function watch(page: Page) {
  const bodies: string[] = [];
  const ai: string[] = [];
  page.on("request", (r) => { const b = r.postData(); if (b) bodies.push(r.url() + " " + b); });
  await page.route("**/api/ai/extract-statement", async (r) => {
    ai.push(r.request().postData() ?? "");
    await r.fulfill({ json: { rows: ROWS, skipped: 0, rowCount: 2, rowsReturned: 2, mode: "gemini" } });
  });
  return { bodies, ai };
}

async function openImport(page: Page) {
  await openAppPage(page, "/accounting/banking");
  await page.getByText("E2E Test Bank", { exact: true }).first().click();
  await page.getByRole("button", { name: "Import statement" }).first().click();
  await page.locator('input[type="file"]').setInputFiles({ name: "r2662-locked-statement.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("statement-password-box")).toBeVisible({ timeout: 30_000 });
}
async function typePassword(page: Page, pw: string) {
  await page.locator("#statement-pdf-password").fill(pw);
  await page.getByRole("button", { name: "Open PDF" }).click();
}

test.describe("R-2662 — locked statement PDF: password box, unlocked in the browser", () => {
  onlyInCardTests();
  test.setTimeout(180_000);

  test("Step 1: Import statement → locked PDF → a password box shows (nothing sent yet)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const w = await watch(page);
    await openImport(page);
    await expect(page.getByTestId("statement-password-box")).toContainText("locked with a password");
    expect(w.ai).toHaveLength(0);
    await page.context().close();
  });

  test("Step 2: wrong password → 'did not open the PDF', box stays, nothing sent", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const w = await watch(page);
    await openImport(page);
    await typePassword(page, "dummy-wrong");
    await expect(page.getByTestId("statement-password-box")).toContainText("did not open the PDF");
    await expect(page.locator("#statement-pdf-password")).toHaveValue("");
    expect(w.ai).toHaveLength(0);
    await page.context().close();
  });

  test("Step 3: right password → preview shows the 2 lines; no request carries the password", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const w = await watch(page);
    await openImport(page);
    await typePassword(page, "dummy-wrong");
    await expect(page.getByTestId("statement-password-box")).toContainText("did not open the PDF");
    await typePassword(page, DUMMY);
    await expect(page.getByText("Parse summary")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("UPI-R2662 DEMO OFFICE SUPPLIES").first()).toBeVisible();
    expect(w.ai).toHaveLength(1);
    const body = JSON.parse(w.ai[0]) as { mimeType: string; fileBase64: string };
    expect(body.mimeType).toBe("text/plain");
    expect(Buffer.from(body.fileBase64, "base64").toString("utf8")).toContain("NEFT CR-R2662 DEMO CUSTOMER");
    const all = w.bodies.join("\n");
    expect(all).not.toContain(DUMMY);
    expect(all).not.toContain("dummy-wrong");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(DUMMY);
    await page.context().close();
  });

  test("Step 4: Google bill check opens a locked PDF the same way", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const w = await watch(page);
    await openAppPage(page, "/accounting/google-bill-check");
    await page.locator('input[type="file"]').setInputFiles({ name: "r2662-locked-bill.pdf", mimeType: "application/pdf", buffer: PDF });
    await expect(page.getByTestId("statement-password-box")).toBeVisible({ timeout: 30_000 });
    await typePassword(page, DUMMY);
    await expect(page.getByTestId("statement-password-box")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("r2662-locked-bill.pdf — choose another")).toBeVisible();
    expect(w.bodies.join("\n")).not.toContain(DUMMY);
    await page.context().close();
  });
});
