/**
 * Card test — R-2604 "Repair tool: move existing 'Advance/loan given' Balance Sheet lines into Loans given
 * (merge same names)".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2604`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 *   · bank account "CT R2604 Current ··2604" with two imported money-out lines, each booked the old way
 *     (book_bank_advance → Balance Sheet line, matched bs_item):
 *       ₹50,000 → "Advance/loan given · CT R2604 Aakash"   ₹30,000 → "Advance/loan given · CT R2604 Staff One"
 *   · one hand-typed Balance Sheet line "Advance/loan given · ct r2604  aakash" ₹20,000 (same person, other case)
 *   · employee "CT R2604 Staff One".
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
const ACCT = "c2604000-0000-4000-8000-000000000a01";
const TXN1 = "c2604000-0000-4000-8000-000000000011";
const TXN2 = "c2604000-0000-4000-8000-000000000012";
const BS1 = "c2604000-0000-4000-8000-000000000021";
const BS2 = "c2604000-0000-4000-8000-000000000022";
const BS3 = "c2604000-0000-4000-8000-000000000023";
const EMP = "c2604000-0000-4000-8000-000000000031";
const AAKASH = "CT R2604 Aakash";
const STAFF = "CT R2604 Staff One";

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
  if (why || !c) throw new Error(`R-2604 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

// Loans first (their delete frees the moved lines), then the audit rows, then the lines.
const CLEAN = (tenant: string) => `
  delete from public.loans_given where tenant_id = '${tenant}' and borrower_name ilike 'CT R2604%';
  delete from public.employee_loans where tenant_id = '${tenant}' and employee_name ilike 'CT R2604%';
  delete from public.bs_loan_moves where tenant_id = '${tenant}' and person_name ilike 'CT R2604%';
  delete from public.balance_sheet_items where id in ('${BS1}', '${BS2}', '${BS3}');
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';
  delete from public.employees where id = '${EMP}';`;

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
    insert into public.employees (id, tenant_id, name) values ('${EMP}', '${tenant}', '${STAFF}');
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance, opening_balance_date)
      values ('${ACCT}', '${tenant}', 'CT R2604 Current', 'HDFC Bank', '2604', 0, current_date - 60);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN1}', '${tenant}', '${ACCT}', current_date - 40, 'IMPS DR CT R2604 AAKASH', 50000, 0, 'csv_upload'),
      ('${TXN2}', '${tenant}', '${ACCT}', current_date - 30, 'IMPS DR CT R2604 STAFF', 30000, 0, 'csv_upload');
    insert into public.balance_sheet_items (id, tenant_id, section, label, amount, bank_txn_id, notes) values
      ('${BS1}', '${tenant}', 'asset', 'Advance/loan given · ${AAKASH}', 50000, '${TXN1}', 'Card test R-2604 — local only'),
      ('${BS2}', '${tenant}', 'asset', 'Advance/loan given · ${STAFF}', 30000, '${TXN2}', 'Card test R-2604 — local only'),
      ('${BS3}', '${tenant}', 'asset', 'Advance/loan given · ct r2604  aakash', 20000, null, 'Card test R-2604 — local only');
    update public.bank_transactions set matched_to_type = 'bs_item', matched_to_id = '${BS1}', match_confidence = 'manual', matched_at = now() where id = '${TXN1}';
    update public.bank_transactions set matched_to_type = 'bs_item', matched_to_id = '${BS2}', match_confidence = 'manual', matched_at = now() where id = '${TXN2}';
    commit;`);
}

test.describe("R-2604 card test", () => {
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

  test("Step 1: Loans given → yellow note → Move to Loans given → Check first shows one Aakash (₹70,000), Staff One as an Employee loan, total unchanged", async () => {
    await openAppPage(page, "/accounting/loans-given");
    const note = page.getByTestId("r2603-old-bs-loans");
    await expect(note).toBeVisible({ timeout: 60_000 });
    await note.getByRole("button", { name: "Move to Loans given" }).click();
    const dlg = page.getByTestId("r2604-move-dialog");
    await expect(dlg).toBeVisible();
    const aakash = dlg.getByTestId("r2604-move-row").filter({ hasText: AAKASH });
    await expect(aakash).toHaveCount(1);
    await expect(aakash).toContainText("₹70,000");
    await expect(aakash).toContainText("New loan on Loans given");
    const staff = dlg.getByTestId("r2604-move-row").filter({ hasText: STAFF });
    await expect(staff).toContainText(`Employee loan — ${STAFF}`);
    await expect(staff.getByRole("checkbox")).toBeChecked();
    await expect(dlg.getByTestId("r2604-move-totals")).toContainText("(unchanged)");
  });

  test("Step 2: Move → the note goes; Loans given lists CT R2604 Aakash ₹70,000; the Staff One line is an Employee loan", async () => {
    const dlg = page.getByTestId("r2604-move-dialog");
    await dlg.getByRole("button", { name: /^Move / }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("r2603-old-bs-loans")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(AAKASH).first()).toBeVisible({ timeout: 30_000 });
    const c = container();
    expect(psql(c, `select borrower_name || '|' || principal from public.loans_given where borrower_name ilike 'CT R2604%';`)).toEqual([`${AAKASH}|70000`]);
    expect(psql(c, `select employee_name || '|' || principal from public.employee_loans where employee_name ilike 'CT R2604%';`)).toEqual([`${STAFF}|30000`]);
    expect(psql(c, `select matched_to_type from public.bank_transactions where id in ('${TXN1}', '${TXN2}') order by id;`)).toEqual(["loan_given", "employee_loan"]);
    expect(psql(c, `select count(*) from public.balance_sheet_items where id in ('${BS1}', '${BS2}', '${BS3}');`)).toEqual(["0"]);
  });

  test("Step 3: Accounting → Loans shows CT R2604 Staff One's ₹30,000 loan", async () => {
    await openAppPage(page, "/accounting/loans");
    await expect(page.getByText(STAFF).first()).toBeVisible({ timeout: 60_000 });
  });
});
