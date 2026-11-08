/**
 * Card test — R-2544 "Customer → Transactions: show each payment under the invoice it paid" (R-2554).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2544`.
 *
 * Data: the local scenario `small-leftover` (scripts/dev/scenario.mjs — E2E Test Co, local docker
 * DB only; it refuses anything else) is (re)loaded once before the steps: SCN Leftover Hosting with
 * INV-SCN-LO-1 ₹354 (nothing paid) and INV-SCN-LO-2 ₹5,900 with one ₹5,845 receipt (SCNUTR2458054).
 * That scenario has no advance for this customer, so the "Advance / not yet against an invoice" part
 * of step 3 can only check that no receipt wrongly lands there — noted on the result.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUSTOMER_ID = "c2458000-0000-4000-8000-000000000051"; // SCN Leftover Hosting (small-leftover.sql)
const RECEIPT_REF = "SCNUTR2458054";

function loadScenario(): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "small-leftover"], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario small-leftover failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

/** The customer's Transactions tab, on the given segment (All / Invoices / Payments …). */
async function openTransactions(page: Page, segment: RegExp): Promise<Locator> {
  await openAppPage(page, `/customers/${CUSTOMER_ID}`, /SCN Leftover Hosting/);
  await page.getByRole("tab", { name: /^Transactions/ }).or(page.getByRole("button", { name: /^Transactions/ })).first().click();
  await page.getByRole("button", { name: segment }).first().click();
  await expect(page.getByRole("status", { name: "Loading transactions" })).toHaveCount(0, { timeout: 60_000 });
  const rows = page.locator("main table tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  return rows;
}

/** Index of the first row whose text contains `text`, or -1. */
async function rowIndex(rows: Locator, text: string): Promise<number> {
  const all = await rows.allInnerTexts();
  return all.findIndex((t) => t.includes(text));
}

/**
 * R-2559: record, from the first paint, whether the receipt ever sat under the Advance group, and the
 * row right above it the first time it showed (it must be INV-SCN-LO-2 from the start, no jump).
 */
async function watchReceiptPlacement(page: Page): Promise<void> {
  await page.addInitScript(([ref, advance]) => {
    const w = window as unknown as { __receipt?: { underAdvance: boolean; firstAbove: string | null } };
    w.__receipt = { underAdvance: false, firstAbove: null };
    const look = () => {
      const rows = [...document.querySelectorAll("main table tbody tr")].map((tr) => tr.textContent ?? "");
      const i = rows.findIndex((t) => t.includes(ref));
      if (i < 0) return;
      if (w.__receipt!.firstAbove === null) w.__receipt!.firstAbove = rows[i - 1] ?? "";
      const g = rows.findIndex((t) => t.includes(advance));
      if (g >= 0 && rows.slice(g + 1).some((t) => t.includes(ref))) w.__receipt!.underAdvance = true;
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  }, [RECEIPT_REF, "Advance / not yet against an invoice"] as const);
}

test.describe("R-2544 — Customer → Transactions: each payment under the invoice it paid", () => {
  onlyInCardTests();

  test.beforeAll(() => {
    if (CARD_TESTS_ON) loadScenario();
  });

  test("Step 1: Owner opens SCN Leftover Hosting → Transactions tab (scenario small-leftover loaded)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const rows = await openTransactions(page, /^All/);
      expect(await rowIndex(rows, "INV-SCN-LO-2"), "INV-SCN-LO-2 row on All").toBeGreaterThanOrEqual(0);
      expect(await rowIndex(rows, "INV-SCN-LO-1"), "INV-SCN-LO-1 row on All").toBeGreaterThanOrEqual(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: under INV-SCN-LO-2 (₹5,900) its ₹5,845 receipt sits indented (↳), invoice says ₹55 due; nothing under INV-SCN-LO-1", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await watchReceiptPlacement(page);
    try {
      const rows = await openTransactions(page, /^All/);
      const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      const i2 = texts.findIndex((t) => t.includes("INV-SCN-LO-2"));
      expect(i2, "INV-SCN-LO-2 row").toBeGreaterThanOrEqual(0);
      const inv2 = texts[i2];
      expect(inv2, "invoice amount ₹5,900").toMatch(/5,900/);
      expect(inv2, "invoice status names the ₹55 due").toMatch(/(Overdue|Part-paid) \(₹\s?55 due\)/);
      const child = texts[i2 + 1] ?? "";
      expect(child, `row right under INV-SCN-LO-2 is its receipt — rows: ${texts.join(" | ")}`).toContain(RECEIPT_REF);
      expect(child, "receipt amount ₹5,845").toMatch(/5,845/);
      await expect(rows.nth(i2 + 1).getByText("↳"), "receipt row is indented with ↳").toHaveCount(1);
      const i1 = texts.findIndex((t) => t.includes("INV-SCN-LO-1"));
      expect(i1, "INV-SCN-LO-1 row").toBeGreaterThanOrEqual(0);
      expect(texts[i1], "INV-SCN-LO-1 amount ₹354").toMatch(/354/);
      const after1 = rows.nth(i1 + 1);
      if (i1 + 1 < texts.length) {
        await expect(after1.getByText("↳"), "no receipt indented under INV-SCN-LO-1").toHaveCount(0);
      }
      // R-2559: on the FIRST paint the receipt was already under its invoice — never under Advance, no jump.
      const placed = await page.evaluate(() => (window as unknown as { __receipt?: { underAdvance: boolean; firstAbove: string | null } }).__receipt);
      expect(placed?.underAdvance, "receipt never showed under 'Advance / not yet against an invoice'").toBe(false);
      expect(placed?.firstAbove ?? "", "first time the receipt showed, the row above it was INV-SCN-LO-2").toContain("INV-SCN-LO-2");
      test.info().annotations.push({ type: "note", description: `LO-2 row: "${inv2}" · under it: "${child}" · LO-1 row: "${texts[i1]}" · first paint: under LO-2, never under Advance` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Payments tab — the receipt's For column says INV-SCN-LO-2; no receipt sits under 'Advance / not yet against an invoice'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const rows = await openTransactions(page, /^Payments/);
      await expect(page.locator("main table thead th").filter({ hasText: /^For$/ })).toHaveCount(1);
      const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      const ir = texts.findIndex((t) => /Payment/.test(t) && t.includes("5,845"));
      expect(ir, `receipt row on Payments — rows: ${texts.join(" | ")}`).toBeGreaterThanOrEqual(0);
      const head = (await page.locator("main table thead th").allInnerTexts()).map((h) => h.trim().toLowerCase());
      const forCol = head.indexOf("for");
      const forCell = (await rows.nth(ir).locator("td").nth(forCol).innerText()).trim();
      expect(forCell, "For column of the receipt").toContain("INV-SCN-LO-2");
      // R-2559: the Reference column shows the UTR typed on the receipt, not the payment's id.
      const refCol = head.indexOf("reference");
      const refCell = (await rows.nth(ir).locator("td").nth(refCol).innerText()).trim();
      expect(refCell, "Reference column of the receipt = its UTR").toContain(RECEIPT_REF);
      // All: this customer has no advance, so no "Advance / not yet against an invoice" group may hold the receipt.
      const all = await openTransactions(page, /^All/);
      const allTexts = (await all.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      const ga = allTexts.findIndex((t) => t.includes("Advance / not yet against an invoice"));
      const advanceRows = ga >= 0 ? allTexts.slice(ga + 1) : [];
      expect(advanceRows.some((t) => t.includes(RECEIPT_REF)), "receipt must not be under the Advance group").toBe(false);
      test.info().annotations.push({ type: "note", description: `Payments row: "${texts[ir]}" — Reference = "${refCell}", For = "${forCell}". Advance group ${ga >= 0 ? "shown" : "not shown (scenario has no advance for this customer)"}.` });
    } finally {
      await page.context().close();
    }
  });
});
