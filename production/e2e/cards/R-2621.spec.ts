/**
 * Card test — R-2621 "No NEW GST sale for a bank line in a GST-filed month; pay the imported Zoho invoice".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2621`.
 *
 * Data: scenario gst-filed (scripts/dev/scenarios/gst-filed.sql) — SCN Filed Month Traders, imported Zoho
 * sale ZB-SCN-GF-1 ₹11,800 (10 Sep 2026), money-in lines 15 Sep ₹11,800, 20 Sep ₹5,900, 5 Oct ₹5,900 on
 * SCN HDFC Current. Loaded fresh before step 1; after the last step the scenario is cleared and E2E Test
 * Co's "GST returns filed up to" is cleared again (local docker DB only).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, localDb, onlyInCardTests, openAppPage, pageAs, pickPayingCustomer, setGstFiledThrough } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const NAME = "SCN Filed Month Traders";
const TXN = { paysZoho: "c2621000-0000-4000-8000-000000000011", sep: "c2621000-0000-4000-8000-000000000012", oct: "c2621000-0000-4000-8000-000000000013" };
const LINE = { paysZoho: "ZB-SCN-GF-1", sep: "TRADERS-SEPT", oct: "TRADERS-OCT" };

/** The local docker DB, guarded (card-steps localDb, R-2666). */
const db = () => localDb("R-2621");

function scenario(flag: "--reset" | "--clear"): void {
  db(); // the local guard first
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "gst-filed", flag], { cwd: PROD, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario gst-filed ${flag} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** The owner's setting is cleared again (postgres session — the guard trigger refuses only request logins). */
function clearSetting(): void {
  db().psql(`update public.tenants set gst_filed_through = null where email = '${E2E_TENANT_EMAIL}';`);
}

function matched(id: string): string {
  return db().one(`select coalesce(matched_to_type, '') from public.bank_transactions where id = '${id}';`);
}

async function openLine(page: Page, text: string, txn: string): Promise<Locator> {
  await openAppPage(page, `/accounting/banking/${ACCT}?txn=${txn}`); // R-1895: scrolled to the line
  const row = page.locator("main table tbody tr").filter({ hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  /* The row paints before its Reconcile button on a busy dev server (10 Nov: 10 s click timeout hit) — wait for it. */
  const reconcile = row.getByRole("button", { name: /^Reconcile$/ });
  await expect(reconcile).toBeVisible({ timeout: 60_000 });
  await reconcile.click();
  const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await pickPayingCustomer(dlg, NAME);
  return dlg;
}

async function newSale(page: Page, dlg: Locator): Promise<void> {
  await dlg.getByRole("button", { name: /^A new sale/ }).click();
  await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "E2E Microsoft 365 Business Basic · microsoft" });
  await dlg.getByRole("combobox", { name: "Commitment" }).selectOption({ label: "Annual commitment" });
  await dlg.getByLabel(/^Seats/).fill("1");
  await dlg.getByLabel(/^Unit price/).fill("5000");
  await page.getByRole("button", { name: /^Record sale & reconcile/ }).click();
}

test.describe("R-2621 — no new GST sale in a filed month; the imported Zoho invoice is paid", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(480_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    clearSetting();
    scenario("--reset");
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON) return;
    clearSetting();
    scenario("--clear");
  });

  test("Step 1: Accounting → Overview → GST returns filed up to → September 2026 → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      /* The stored month loads first — typing before it lands is overwritten by it (9 Nov re-run); the helper waits
         for it and checks the typed month stayed (R-2666). */
      await setGstFiledThrough(page, "2026-09", "September 2026");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Banking → 20 Sep ₹5,900 line → A new sale → refused 'GST for Sep 2026 is already filed', line stays unmatched", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openLine(page, LINE.sep, TXN.sep);
      await newSale(page, dlg);
      await expect(page.getByText(/GST for Sep 2026 is already filed/).first()).toBeVisible({ timeout: 120_000 });
      expect(matched(TXN.sep)).toBe("");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: 15 Sep ₹11,800 line → An open quote / invoice → ZB-SCN-GF-1 → paid (no new sale)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openLine(page, LINE.paysZoho, TXN.paysZoho);
      await dlg.getByRole("button", { name: /^An open quote \/ invoice/ }).click();
      await dlg.getByRole("radiogroup", { name: "Open quotes and invoices" }).getByRole("radio").filter({ hasText: "ZB-SCN-GF-1" }).first().click();
      await page.getByRole("button", { name: "Record ₹11,800 on ZB-SCN-GF-1 & reconcile" }).click();
      await expect(dlg.getByRole("region", { name: "Done — this bank line is reconciled" })).toBeVisible({ timeout: 240_000 });
      const { psql } = db();
      /* What the line was matched to + the receipts on the invoice — named in the failure if not paid. */
      const state = () => psql(`select coalesce(t.matched_to_type, '-') || ':' || coalesce(t.matched_to_id, '-') || ' | inv ' || i.status || ' paid ' || i.paid_amount
          || ' | receipts ' || (select count(*) from public.payments p where p.invoice_id = i.id and p.status = 'received')
        from public.bank_transactions t, public.invoices i where t.id = '${TXN.paysZoho}' and i.id = 'ZB-SCN-GF-1';`)[0] ?? "";
      await expect.poll(state, { timeout: 15_000, message: "the line pays ZB-SCN-GF-1 (receipt on it, invoice paid)" }).toMatch(/^payment:.* \| inv paid paid 11800 \| receipts 1$/);
      expect(psql("select status::text || '|' || taxable_value from public.invoices where id = 'ZB-SCN-GF-1';")[0]).toBe("paid|10000");
      expect(psql(`select count(*) from public.invoices i join public.customers cu on cu.id = i.customer_id where cu.name = '${NAME}';`)[0]).toBe("1");
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: 5 Oct ₹5,900 line (open month) → A new sale books as before", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openLine(page, LINE.oct, TXN.oct);
      await newSale(page, dlg);
      await expect(dlg.getByRole("region", { name: "Done — this bank line is reconciled" })).toBeVisible({ timeout: 240_000 });
      expect(matched(TXN.oct)).not.toBe("");
    } finally {
      await page.context().close();
    }
  });
});
