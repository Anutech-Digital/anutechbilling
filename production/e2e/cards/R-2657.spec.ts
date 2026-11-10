/**
 * Card test — R-2657 "No-vendor sheet: group by payee + 'always book like this'".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2657`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 *   · a bank account "CT R2657 Current ··2657" with six money-out lines, none with a vendor:
 *       P1 ₹700  "UPI-ZQX PAYEE KAPOOR-9999@YBL-…-EXP"      } one payee group (2 lines)
 *       P2 ₹450  "UPI-ZQX PAYEE KAPOOR-9999@YBL-…-TEA"      }
 *       G1 ₹61   "…I049903313 DPO2608902104710 CGST"        } the bank's GST on charges — one group,
 *       G2 ₹61   "…I049903313 DPO2608902104710 SGST"        } suggested Bank Charges (GST ₹0)
 *       Z  ₹3,333 "NEFT DR-ZQX ZOHO VENDOR-…"              covered by a Zoho-imported expense (D1) — not offered
 *   · that Zoho-imported expense (₹3,333, zoho_doc_id expenses:CT2657, no bank line yet).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c2657000-0000-4000-8000-000000000a01";
const P1 = "c2657000-0000-4000-8000-000000000011";
const P2 = "c2657000-0000-4000-8000-000000000012";
const G1 = "c2657000-0000-4000-8000-000000000013";
const G2 = "c2657000-0000-4000-8000-000000000014";
const Z = "c2657000-0000-4000-8000-000000000015";
const PATTERN = "ZQX PAYEE KAPOOR";
const ZEXP = "EXP-CT2657-Z";

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
  if (why || !c) throw new Error(`R-2657 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const IDS = `'${P1}','${P2}','${G1}','${G2}','${Z}'`;
const CLEAN = (tenant: string) => `
  select set_config('app.zoho_purchase_import', 'on', true);
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where bank_account_id = '${ACCT}';
  delete from public.expenses where tenant_id = '${tenant}' and (reconciled_txn_id in (${IDS}) or id = '${ZEXP}');
  delete from public.txn_category_rules where tenant_id = '${tenant}' and upper(pattern) = '${PATTERN}';
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';`;

function e2eTenant(c: string): string {
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  return tenants[0].trim();
}

function clean(): void {
  const c = container();
  psql(c, `begin; ${CLEAN(e2eTenant(c))} commit;`);
}

function seed(): void {
  const c = container();
  const tenant = e2eTenant(c);
  psql(c, `
    begin;
    ${CLEAN(tenant)}
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance, opening_balance_date)
      values ('${ACCT}', '${tenant}', 'CT R2657 Current', 'HDFC Bank', '2657', 0, current_date - 30);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, category, category_source) values
      ('${P1}', '${tenant}', '${ACCT}', current_date - 9, 'UPI-ZQX PAYEE KAPOOR-9999@YBL-HDFC0000089-544244313572-EXP', 700, 0, 'csv_upload', null, null),
      ('${P2}', '${tenant}', '${ACCT}', current_date - 8, 'UPI-ZQX PAYEE KAPOOR-9999@YBL-HDFC0000089-544244313573-TEA', 450, 0, 'csv_upload', null, null),
      ('${G1}', '${tenant}', '${ACCT}', current_date - 7, '300326I049903313 DPO2608902104710 CGST', 61, 0, 'csv_upload', null, null),
      ('${G2}', '${tenant}', '${ACCT}', current_date - 7, '300326I049903313 DPO2608902104710 SGST', 61, 0, 'csv_upload', null, null),
      ('${Z}', '${tenant}', '${ACCT}', current_date - 5, 'NEFT DR-HDFC0000001-ZQX ZOHO VENDOR-NETBANK', 3333, 0, 'csv_upload', null, null);
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, paid, paid_date, zoho_doc_id, zoho_leg)
      values ('${ZEXP}', '${tenant}', 'Office Supplies', 'ZQX Zoho Vendor', current_date - 6, 3333, 0, true, current_date - 6, 'expenses:CT2657', 1);
    commit;`);
}

const bookedRows = () => psql(container(), `select t.description || '|' || coalesce(e.category, '-') || '|' || coalesce(e.gst_paid::text, '-')
  from public.bank_transactions t left join public.expenses e on e.id = t.matched_to_id
  where t.bank_account_id = '${ACCT}' order by t.txn_date, t.description;`);
const ruleRows = () => psql(container(), `select upper(pattern) || '|' || category || '|' || direction from public.txn_category_rules
  where upper(pattern) = '${PATTERN}';`);

test.describe("R-2657 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: CT R2657 account → 'No-vendor lines' opens By payee: the payee group (2 lines), the bank GST group on Bank Charges; the Zoho-covered line is not offered", async () => {
    await openAppPage(page, `/accounting/banking/${ACCT}`);
    const open = page.getByRole("button", { name: /^No-vendor lines \(\d+\)$/ });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await open.click();
    const sheet = page.getByRole("dialog", { name: /Book no-vendor lines/ });
    await expect(sheet).toBeVisible();
    const payee = sheet.getByTestId("bulk-expense-group-payee:zqx payee kapoor");
    await expect(payee).toContainText("2 lines", { timeout: 30_000 });
    await expect(payee).toContainText("₹1,150");
    const gst = sheet.getByTestId("bulk-expense-group-bank-gst");
    await expect(gst).toContainText("Bank GST on charges");
    await expect(sheet.getByLabel(/^Category for every line paid to Bank GST/)).toHaveValue("Bank Charges");
    await expect(sheet.getByTestId("bulk-expense-covered")).toContainText("1 line is not shown");
    await expect(sheet.getByText("ZQX ZOHO VENDOR")).toHaveCount(0);
  });

  test("Step 2: pick Staff Welfare for the payee group + 'Always book like this', tick it, Book selected (2) → 2 booked, rule saved", async () => {
    const sheet = page.getByRole("dialog", { name: /Book no-vendor lines/ });
    await sheet.getByLabel("Category for every line paid to Zqx Payee Kapoor").selectOption("Staff Welfare");
    const payee = sheet.getByTestId("bulk-expense-group-payee:zqx payee kapoor");
    await payee.getByLabel("Always book like this").check();
    await payee.getByLabel(/^Tick the 2 lines paid to/).check();
    await sheet.getByRole("button", { name: "Book selected (2)" }).click();
    await expect(sheet.getByTestId("bulk-expense-result")).toContainText("2 booked · 0 not booked", { timeout: 60_000 });
    await expect(sheet.getByTestId("bulk-expense-result")).toContainText("1 payee rule saved", { timeout: 30_000 });
    await expect.poll(ruleRows, { timeout: 30_000 }).toEqual([`${PATTERN}|Staff Welfare|debit`]);
  });

  test("Step 3: tick the bank GST group, Book selected (2) → both booked as Bank Charges with GST 0; the Zoho-covered line stays open", async () => {
    const sheet = page.getByRole("dialog", { name: /Book no-vendor lines/ });
    const gst = sheet.getByTestId("bulk-expense-group-bank-gst");
    await expect(gst).toBeVisible({ timeout: 30_000 });
    await gst.getByLabel(/^Tick the 2 lines paid to Bank GST/).check();
    await sheet.getByRole("button", { name: "Book selected (2)" }).click();
    await expect(sheet.getByTestId("bulk-expense-result")).toContainText("2 booked · 0 not booked", { timeout: 60_000 });
    await expect.poll(bookedRows, { timeout: 30_000 }).toEqual([
      "UPI-ZQX PAYEE KAPOOR-9999@YBL-HDFC0000089-544244313572-EXP|Staff Welfare|0",
      "UPI-ZQX PAYEE KAPOOR-9999@YBL-HDFC0000089-544244313573-TEA|Staff Welfare|0",
      "300326I049903313 DPO2608902104710 CGST|Bank Charges|0",
      "300326I049903313 DPO2608902104710 SGST|Bank Charges|0",
      "NEFT DR-HDFC0000001-ZQX ZOHO VENDOR-NETBANK|-|-",
    ]);
  });
});
