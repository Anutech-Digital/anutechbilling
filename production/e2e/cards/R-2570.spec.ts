/**
 * Card test — R-2570 "Bank line likhne wale functions apna asli type likhein (loan/advance/credit) —
 * 'manual' ki jagah".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2570` (needs migration 20261107165630 on the local DB).
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 * a bank account "CT R2570 Current ··2570" with one imported line booked through the RPC the Reconcile
 * sheet's "Loan / advance with a person" calls (book_bank_advance, kind "received"), and one payout line
 * Loans given → Give loan writes itself (give_loan), both as the company's owner:
 *   · ₹5,00,000 in "NEFT CR BAJAJ FINANCE CT R2570" → bs_item · Loan received · Bajaj Finance
 *   · ₹20,000 out  "Loan given: CT R2570 Ravi"     → loan_given · Loan given · CT R2570 Ravi
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
const ACCT = "c2570000-0000-4000-8000-000000000a01";
const TXN_BAJAJ = "c2570000-0000-4000-8000-000000000011";
const LINE_BAJAJ = "NEFT CR BAJAJ FINANCE CT R2570";
const BORROWER = "CT R2570 Ravi";

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
  if (why || !c) throw new Error(`R-2570 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/* The loan goes first (delete_loan_given would also remove its line; a direct delete keeps it simple). */
const CLEAN = `
  delete from public.loans_given where paid_from_account_id = '${ACCT}';
  delete from public.balance_sheet_items where bank_txn_id = '${TXN_BAJAJ}';
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';`;

function clean(): void {
  psql(container(), `begin; ${CLEAN} commit;`);
}

function seed(): void {
  const c = container();
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  const tenant = tenants[0].trim();
  const owners = psql(c, `select id from public.users where tenant_id = '${tenant}' and role = 'owner' order by created_at limit 1;`);
  if (owners.length !== 1) throw new Error("E2E Test Co has no owner user");
  psql(c, `
    begin;
    ${CLEAN}
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance, opening_balance_date)
      values ('${ACCT}', '${tenant}', 'CT R2570 Current', 'HDFC Bank', '2570', 0, current_date - 30);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN_BAJAJ}', '${tenant}', '${ACCT}', current_date - 5, '${LINE_BAJAJ}', 0, 500000, 'csv_upload');
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${owners[0].trim()}', 'role', 'authenticated')::text, true);
    select public.book_bank_advance('${TXN_BAJAJ}', 'Bajaj Finance', 'received', 'Card test R-2570 — local only');
    select public.give_loan('${BORROWER}', 'person', 20000, current_date - 3, '${ACCT}');
    commit;`);
}

test.describe("R-2570 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

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

  test("Step 1: the line booked through Loan / EMI → Loan received (Bajaj) is stored as its own type, not 'manual'", async () => {
    const c = container();
    expect(psql(c, `select matched_to_type || '|' || (matched_to_id is not null) from public.bank_transactions where id = '${TXN_BAJAJ}';`))
      .toEqual(["bs_item|true"]);
    expect(psql(c, `select matched_to_type || '|' || (matched_to_id is not null) from public.bank_transactions where bank_account_id = '${ACCT}' and description = 'Loan given: ${BORROWER}';`))
      .toEqual(["loan_given|true"]);
  });

  test("Step 2: Banking → the line shows \"Loan received · Bajaj Finance\" (and the Give loan line its borrower)", async () => {
    await openAppPage(page, `/accounting/banking/${ACCT}`);
    const bajaj = page.locator(`tr[data-txn-id="${TXN_BAJAJ}"]`);
    await expect(bajaj).toBeVisible({ timeout: 60_000 });
    await expect(bajaj.getByText("Loan received", { exact: true })).toBeVisible();
    await expect(bajaj.getByTestId("line-booking")).toHaveText("Bajaj Finance");
    await expect(bajaj.getByText("Reconciled", { exact: true })).toHaveCount(0);
    const given = page.locator("tr", { hasText: `Loan given: ${BORROWER}` });
    await expect(given.getByTestId("line-booking")).toHaveText(BORROWER);
  });

  test("Step 3: CSV export says the same type", async () => {
    test.skip(true, "CSV Status = lineStatusText(); the bs_item / loan_given cases are unit-tested in bank-filters.test.ts (R-2570)");
  });
});
