/**
 * Card test — R-2603 "Loans given: reconcile 'I am GIVING a loan' creates a real Loans given row
 * (one store), empty page points to old Balance Sheet lines".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2603`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 *   · a bank account "CT R2603 Current ··2603" with one imported money-out line
 *     ₹75,000 "IMPS DR CT R2603 JULIE"
 *   · one old Balance Sheet line "Advance/loan given · CT R2603 Old Borrower" ₹10,000 — how
 *     book_bank_advance booked a loan given before R-2603.
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
const ACCT = "c2603000-0000-4000-8000-000000000a01";
const TXN = "c2603000-0000-4000-8000-000000000011";
const BS_ITEM = "c2603000-0000-4000-8000-000000000021";
const LINE = "IMPS DR CT R2603 JULIE";
const BORROWER = "CT R2603 Julie";
const OLD_BORROWER = "CT R2603 Old Borrower";

/* ── local docker DB (same guard as scripts/dev/scenario.mjs) ── */
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
  if (why || !c) throw new Error(`R-2603 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const CLEAN = (tenant: string) => `
  delete from public.loan_repayments where loan_id in (select id from public.loans_given where tenant_id = '${tenant}' and (bank_txn_id = '${TXN}' or borrower_name ilike 'CT R2603%'));
  delete from public.loans_given where tenant_id = '${tenant}' and (bank_txn_id = '${TXN}' or borrower_name ilike 'CT R2603%');
  delete from public.balance_sheet_items where id = '${BS_ITEM}' or bank_txn_id = '${TXN}';
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
      values ('${ACCT}', '${tenant}', 'CT R2603 Current', 'HDFC Bank', '2603', 0, current_date - 30);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN}', '${tenant}', '${ACCT}', current_date - 3, '${LINE}', 75000, 0, 'csv_upload');
    insert into public.balance_sheet_items (id, tenant_id, section, label, amount, notes)
      values ('${BS_ITEM}', '${tenant}', 'asset', 'Advance/loan given · ${OLD_BORROWER}', 10000, 'Card test R-2603 — local only');
    commit;`);
}

function loanRow(): string[] {
  return psql(container(), `select l.borrower_name || '|' || l.principal || '|' || l.repayment_plan || '|' || t.matched_to_type
    from public.loans_given l join public.bank_transactions t on t.id = l.bank_txn_id where l.bank_txn_id = '${TXN}';`);
}

test.describe("R-2603 card test", () => {
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

  test("Step 1: Banking → the ₹75,000 line → Reconcile → Loan / EMI → 'I am GIVING a loan' → name → Book → line reconciled as a loan given", async () => {
    await openAppPage(page, `/accounting/banking/${ACCT}`);
    const row = page.locator(`tr[data-txn-id="${TXN}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: /^Reconcile$/ }).click();
    const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
    await dlg.getByRole("radio", { name: /^Loan \/ EMI/ }).click();
    await dlg.getByRole("radio", { name: /I am GIVING a loan\/advance/ }).click();
    await dlg.getByLabel("Person's name (e.g. Julie Rawat)").fill(BORROWER);
    await expect(dlg.getByText(/Goes to\s+Accounting → Loans given/)).toBeVisible();
    const book = page.getByRole("button", { name: "Book ₹75,000 as a loan given (Loans given)" });
    await expect(book).toBeEnabled({ timeout: 60_000 }); // waits for the role check (owner)
    await book.click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect.poll(loanRow, { timeout: 30_000 }).toEqual([`${BORROWER}|75000|one_shot|loan_given`]);
    expect(psql(container(), `select count(*) from public.balance_sheet_items where bank_txn_id = '${TXN}';`)).toEqual(["0"]);
  });

  test("Step 2: Accounting → Loans given lists the loan, and the note names the old Balance Sheet loan line", async () => {
    await openAppPage(page, "/accounting/loans-given");
    await expect(page.getByText(BORROWER).first()).toBeVisible({ timeout: 60_000 });
    const note = page.getByTestId("r2603-old-bs-loans");
    await expect(note).toBeVisible();
    await expect(note).toContainText(OLD_BORROWER);
    await expect(note).toContainText("still a Balance Sheet line");
  });
});
