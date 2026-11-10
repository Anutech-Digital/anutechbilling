/**
 * Card test — R-2611 "Reconcile in bulk: money-out lines with no vendor — owner ticks many and
 * books them at once".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2611`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 *   · a bank account "CT R2611 Current ··2611" with four money-out lines, none with a vendor:
 *       A ₹2,000    "POS ZQXR2611 QZW"    Category Rule ZQXR2611 → Advertising (high)
 *       B ₹1,50,000 "NEFT ZQXR2611 QZV"      same rule (high) but ≥ ₹1,00,000 — never ticked for you
 *       C ₹2,500    "NEFT CT R2611 CLOUDHOST"  category Hosting from the import (medium)
 *       D ₹900      "ITNS 281 CT R2611"        a TDS challan — never in the bulk list
 *   · the Category Rule ZQXR2611 → Advertising (debit).
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
const ACCT = "c2611000-0000-4000-8000-000000000a01";
const A = "c2611000-0000-4000-8000-000000000011";
const B = "c2611000-0000-4000-8000-000000000012";
const C = "c2611000-0000-4000-8000-000000000013";
const D = "c2611000-0000-4000-8000-000000000014";
const PATTERN = "ZQXR2611";

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
  if (why || !c) throw new Error(`R-2611 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const CLEAN = (tenant: string) => `
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where bank_account_id = '${ACCT}';
  delete from public.expenses where tenant_id = '${tenant}' and reconciled_txn_id in ('${A}','${B}','${C}','${D}');
  delete from public.txn_category_rules where tenant_id = '${tenant}' and pattern = '${PATTERN}';
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
      values ('${ACCT}', '${tenant}', 'CT R2611 Current', 'HDFC Bank', '2611', 0, current_date - 30);
    insert into public.txn_category_rules (tenant_id, pattern, category, direction) values ('${tenant}', '${PATTERN}', 'Advertising', 'debit');
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, category, category_source) values
      ('${A}', '${tenant}', '${ACCT}', current_date - 6, 'POS ZQXR2611 QZW', 2000, 0, 'csv_upload', null, null),
      ('${B}', '${tenant}', '${ACCT}', current_date - 5, 'NEFT ZQXR2611 QZV', 150000, 0, 'csv_upload', null, null),
      ('${C}', '${tenant}', '${ACCT}', current_date - 4, 'NEFT CT R2611 CLOUDHOST', 2500, 0, 'csv_upload', 'Hosting', 'manual'),
      ('${D}', '${tenant}', '${ACCT}', current_date - 3, 'ITNS 281 CT R2611', 900, 0, 'csv_upload', null, null);
    commit;`);
}

const booked = () => psql(container(), `select t.description || '|' || coalesce(e.category, '-') || '|' || coalesce(e.amount::text, '-')
  from public.bank_transactions t left join public.expenses e on e.id = t.matched_to_id
  where t.bank_account_id = '${ACCT}' order by t.txn_date;`);

test.describe("R-2611 card test", () => {
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

  test("Step 1: Banking → CT R2611 account → 'No-vendor lines' shows 3 lines with their suggestion; the TDS challan is not there", async () => {
    await openAppPage(page, `/accounting/banking/${ACCT}`);
    const open = page.getByRole("button", { name: /^No-vendor lines \(\d+\)$/ });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await open.click();
    const sheet = page.getByRole("dialog", { name: /Book no-vendor lines/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId(`bulk-expense-row-${A}`)).toContainText("High", { timeout: 30_000 });
    await expect(sheet.getByTestId(`bulk-expense-row-${B}`)).toContainText("High", { timeout: 30_000 });
    await expect(sheet.getByTestId(`bulk-expense-row-${C}`)).toContainText("Medium");
    await expect(sheet.getByTestId(`bulk-expense-row-${D}`)).toHaveCount(0);
    await expect(sheet.getByLabel("Category for the ₹2,500 line")).toHaveValue("Hosting");
  });

  test("Step 2: 'Tick all high-confidence' ticks the ₹2,000 line only (₹1,50,000 stays unticked); tick ₹2,500 too, Book selected (2) → 2 booked", async () => {
    const sheet = page.getByRole("dialog", { name: /Book no-vendor lines/ });
    await sheet.getByRole("button", { name: /^Tick all high-confidence \(1\)$/ }).click();
    await expect(sheet.getByLabel(/Book the ₹2,000 line/)).toBeChecked();
    await expect(sheet.getByLabel(/Book the ₹1,50,000 line/)).not.toBeChecked();
    await sheet.getByLabel(/Book the ₹2,500 line/).check();
    await sheet.getByRole("button", { name: "Book selected (2)" }).click();
    await expect(sheet.getByTestId("bulk-expense-result")).toContainText("2 booked · 0 not booked", { timeout: 60_000 });
    await expect.poll(booked, { timeout: 30_000 }).toEqual([
      "POS ZQXR2611 QZW|Advertising|2000",
      "NEFT ZQXR2611 QZV|-|-",
      "NEFT CT R2611 CLOUDHOST|Hosting|2500",
      "ITNS 281 CT R2611|-|-",
    ]);
    await expect(sheet.getByTestId(`bulk-expense-row-${A}`)).toHaveCount(0, { timeout: 30_000 });
  });
});
