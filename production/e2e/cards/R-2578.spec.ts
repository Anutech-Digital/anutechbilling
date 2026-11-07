/**
 * Card test — R-2578 "Quote Preview → Print / Save as PDF prints the quote, not the page behind".
 *
 * Before this card the print styles hid every `.fixed` element (FAB, bottom nav, bug reporter) —
 * and the Radix dialog is `.fixed` too, so the quote Preview dialog's "Print / Save as PDF"
 * printed the quote hub page behind it (Draft/Sent steps), never the customer's quote document.
 * Now a dialog that marks its content `print-target` is the ONLY thing on paper while it is open;
 * with no such dialog open, printing a page works exactly as before.
 *
 * How: page.emulateMedia({ media: "print" }) is what Chrome's print preview renders; what is
 * visible there (getClientRects / Playwright visibility) is what lands on paper.
 *
 * Data: scenario "zero-ref-credits" (R-2458) — quote Q-SCN-ZR-3 and invoice INV-SCN-ZR-3 in
 * E2E Test Co (local docker DB only; scenario.mjs refuses anything else). Loaded only when neither
 * is there, and then cleared again at the end; if only one is missing it is reloaded and left
 * loaded (a clear would also remove the one that was there before) — same rule as R-2576.
 * Run: `node scripts/ops/card-tests.mjs R-2578`.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const INVOICE = "INV-SCN-ZR-3";
const QUOTE = "Q-SCN-ZR-3";
const SCENARIO = "zero-ref-credits";

function scenario(...args: string[]) {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...args], { stdio: "pipe", timeout: 120_000 });
}

/** True when the page shows the document, false when it says "not found" (pages render client-side: HTTP is 200 either way). */
async function documentShown(page: Page, path: string, docNo: string): Promise<boolean> {
  await page.goto(path);
  const doc = page.locator("main").getByText(docNo, { exact: true }).first();
  const missing = page.getByText(/not found/i).first();
  await expect(doc.or(missing)).toBeVisible({ timeout: 120_000 });
  return doc.isVisible();
}

/** Quote hub → Preview: the dialog with the customer's document is open (on screen). */
async function openQuotePreview(page: Page) {
  await page.emulateMedia({ media: "screen" });
  await openAppPage(page, `/quotes/${QUOTE}`);
  await expect(page.locator("main").getByText(QUOTE, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await page.locator("main").getByRole("button", { name: "Preview", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("preview-document")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("button", { name: /Print \/ Save as PDF/ })).toBeVisible();
  return dialog;
}

test.describe("R-2578 — Print / Save as PDF from the quote Preview prints the quote document", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let loadedByUs = false;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const inv = await documentShown(page, `/invoices/${INVOICE}`, INVOICE);
      const quo = await documentShown(page, `/quotes/${QUOTE}`, QUOTE);
      if (!inv || !quo) {
        scenario("--reset");
        loadedByUs = !inv && !quo; // clear at the end only what this test brought in
      }
    } finally {
      await page.context().close();
    }
  });

  test.afterAll(() => {
    if (loadedByUs) scenario("--clear");
  });

  test("Step 1: Quote → Preview → Print: the paper shows the quote document (header, Bill to, totals), not the page behind", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dialog = await openQuotePreview(page);
      await page.emulateMedia({ media: "print" });

      const doc = dialog.getByTestId("preview-document");
      await expect(doc, "the quote document is on paper").toBeVisible();
      await expect(doc.getByText(QUOTE, { exact: true }).first(), "quote number printed").toBeVisible();
      await expect(doc.getByText("Bill to", { exact: true }).first(), "'Bill to' printed").toBeVisible();
      await expect(doc.getByText("Taxable amount", { exact: true }).first(), "line totals printed").toBeVisible();
      await expect(doc.getByText(/^(Grand total|Per invoice)/).first(), "Total printed").toBeVisible();

      // The page behind (quote hub with its Draft/Sent steps) is not on paper.
      await expect(page.locator("main"), "the quote hub page behind the dialog is hidden in print").toBeHidden();
      // Nor the dialog's own toolbar / close button, nor the dimmed overlay.
      await expect(dialog.getByRole("button", { name: /Print \/ Save as PDF/ })).toBeHidden();
      await expect(dialog.getByRole("button", { name: "Close" }).first()).toBeHidden();

      // The document starts at the top of the paper (no empty page or offset from the on-screen dialog box)
      // and uses the paper's width instead of the dialog's centred, translated box.
      const box = await doc.boundingBox();
      expect(box, "document has a box in print").not.toBeNull();
      expect(box!.y, "document starts at the top of the page").toBeLessThan(80);
      expect(box!.x, "document starts at the left margin").toBeLessThan(40);
      const pageText = await page.evaluate(() => document.body.innerText);
      expect(pageText, "printed text contains the quote number").toContain(QUOTE);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: dialog closed again → printing the quote page prints the page as before", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dialog = await openQuotePreview(page);
      await dialog.getByRole("button", { name: "Close" }).first().click();
      await expect(dialog).toBeHidden();
      await page.emulateMedia({ media: "print" });
      await expect(page.locator("main").getByText(QUOTE, { exact: true }).first(), "page content prints").toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: a normal page (invoice) still prints its own content, app shell hidden", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/invoices/${INVOICE}`);
      await expect(page.locator("main").getByText(INVOICE, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await page.emulateMedia({ media: "print" });
      await expect(page.locator("main").getByText(INVOICE, { exact: true }).first(), "invoice prints").toBeVisible();
      await expect(page.locator("aside").first(), "sidebar stays off paper").toBeHidden();
    } finally {
      await page.context().close();
    }
  });
});
