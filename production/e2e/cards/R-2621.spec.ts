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
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs, pickPayingCustomer } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const NAME = "SCN Filed Month Traders";
const TXN = { paysZoho: "c2621000-0000-4000-8000-000000000011", sep: "c2621000-0000-4000-8000-000000000012", oct: "c2621000-0000-4000-8000-000000000013" };
const LINE = { paysZoho: "ZB-SCN-GF-1", sep: "TRADERS-SEPT", oct: "TRADERS-OCT" };

function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env: Record<string, string> = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`R-2621 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function scenario(flag: "--reset" | "--clear"): void {
  container(); // the local guard first
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "gst-filed", flag], { cwd: PROD, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario gst-filed ${flag} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** The owner's setting is cleared again (postgres session — the guard trigger refuses only request logins). */
function clearSetting(): void {
  const c = container();
  psql(c, `update public.tenants set gst_filed_through = null where email = '${E2E_TENANT_EMAIL}';`);
}

function matched(id: string): string {
  const c = container();
  return (psql(c, `select coalesce(matched_to_type, '') from public.bank_transactions where id = '${id}';`)[0] ?? "").trim();
}

async function openLine(page: Page, text: string, txn: string): Promise<Locator> {
  await openAppPage(page, `/accounting/banking/${ACCT}?txn=${txn}`); // R-1895: scrolled to the line
  const row = page.locator("main table tbody tr").filter({ hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Reconcile$/ }).click();
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
      await openAppPage(page, "/accounting");
      const card = page.getByTestId("gst-filed-through-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      /* The stored month loads first — typing before it lands is overwritten by it (9 Nov re-run). */
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("Not set", { timeout: 60_000 });
      await card.getByLabel("GST returns filed up to (month)").fill("2026-09");
      await expect(card.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 30_000 });
      await card.getByRole("button", { name: "Save" }).click();
      await page.getByRole("button", { name: "Save" }).last().click(); // the confirm dialog
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("GST returns are filed up to September 2026", { timeout: 60_000 });
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
      const c = container();
      /* What the line was matched to + the receipts on the invoice — named in the failure if not paid. */
      const state = () => psql(c, `select coalesce(t.matched_to_type, '-') || ':' || coalesce(t.matched_to_id, '-') || ' | inv ' || i.status || ' paid ' || i.paid_amount
          || ' | receipts ' || (select count(*) from public.payments p where p.invoice_id = i.id and p.status = 'received')
        from public.bank_transactions t, public.invoices i where t.id = '${TXN.paysZoho}' and i.id = 'ZB-SCN-GF-1';`)[0] ?? "";
      await expect.poll(state, { timeout: 15_000, message: "the line pays ZB-SCN-GF-1 (receipt on it, invoice paid)" }).toMatch(/^payment:.* \| inv paid paid 11800 \| receipts 1$/);
      expect(psql(c, "select status::text || '|' || taxable_value from public.invoices where id = 'ZB-SCN-GF-1';")[0]).toBe("paid|10000");
      expect(psql(c, `select count(*) from public.invoices i join public.customers cu on cu.id = i.customer_id where cu.name = '${NAME}';`)[0]).toBe("1");
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
