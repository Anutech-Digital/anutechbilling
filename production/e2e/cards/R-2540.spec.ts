/**
 * Card test — R-2540 "Invoice PDF/detail + IRN warning use the invoice's own buyer GSTIN/address (as filed)".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2540`.
 *
 * Data: the local scenario `zoho-as-filed` (scripts/dev/scenario.mjs — local docker DB only) is
 * (re)loaded once: SCN As Filed Traders (GSTIN 27AAHCS1234K1Z5, Baner Road, Pune) with ZB-SCN-AF-1
 * (filed in Zoho as B2C — no GSTIN) and ZB-SCN-AF-2 (its Karnataka branch, GSTIN 29AAHCS1234K1Z1,
 * MG Road, Bengaluru).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const LIVE_GSTIN = "27AAHCS1234K1Z5";

function loadScenario(): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "zoho-as-filed"], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario zoho-as-filed failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

/** The invoice page with its Tax Invoice (PDF) dialog open; returns the dialog's text. */
async function taxInvoiceText(page: Page, id: string): Promise<string> {
  /* ?pdf=1 opens the dialog once the seller identity has loaded (a click before that only toasts). */
  await openAppPage(page, `/invoices/${id}?pdf=1`, new RegExp(id));
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await expect(dlg).toContainText("SCN As Filed Traders", { timeout: 60_000 });
  return dlg.innerText();
}

test.describe("R-2540 — an invoice prints its own buyer, as filed", () => {
  onlyInCardTests();

  test.beforeAll(() => loadScenario());

  test("Step 1: ZB-SCN-AF-1 (B2C in Zoho) prints no buyer GSTIN", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const text = await taxInvoiceText(page, "ZB-SCN-AF-1");
    expect(text).not.toContain(LIVE_GSTIN);
  });

  test("Step 2: ZB-SCN-AF-2 (Karnataka branch) prints its own GSTIN, Bengaluru address and Karnataka", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const text = await taxInvoiceText(page, "ZB-SCN-AF-2");
    expect(text).toContain("29AAHCS1234K1Z1");
    expect(text).toContain("MG Road, Bengaluru");
    expect(text).toMatch(/Karnataka/);
    expect(text).not.toContain("Baner Road");
    expect(text).not.toContain(LIVE_GSTIN);
  });

  test("Step 3: emailed PDF + e-invoice (IRN) warning", async () => {
    test.skip(true, "The emailed PDF needs a signed link and the IRN banner a turnover over ₹5 Cr — both proven by unit tests (build-props.test.ts R-2540, invoice-buyer.test.ts invoiceIrnGstin).");
  });
});
