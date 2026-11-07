/**
 * Card test — R-2378 "Bank line booked through Loan / EMI → 'Loan / advance with a person' shows as
 * 'manual, no entry' — show the loan booking and the party on the line".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2378`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 * a bank account "CT R2378 OD ··2378" with two imported lines, each booked through the same RPC the
 * Reconcile sheet's "Loan / advance with a person" calls (book_bank_advance, kind "received"), as the
 * company's owner:
 *   · ₹5,00,000 in  "NEFT CR BAJAJ FINANCE CT R2378"  → Loan received · Bajaj Finance
 *   · ₹25,000 out   "ACH DR TATA CAPITAL EMI CT R2378" → Loan repaid · Tata Capital
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
const ACCT = "c2378000-0000-4000-8000-000000000a01";
const TXN = { bajaj: "c2378000-0000-4000-8000-000000000011", tata: "c2378000-0000-4000-8000-000000000012" };
const LINE = { bajaj: "NEFT CR BAJAJ FINANCE CT R2378", tata: "ACH DR TATA CAPITAL EMI CT R2378" };

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
  if (why || !c) throw new Error(`R-2378 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const CLEAN = `
  delete from public.balance_sheet_items where bank_txn_id in ('${TXN.bajaj}', '${TXN.tata}');
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';`;

function clean(): void {
  psql(container(), `begin; ${CLEAN} commit;`);
}

/** Remove what an earlier run made, then the account + two lines, booked as the owner would. */
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
      values ('${ACCT}', '${tenant}', 'CT R2378 OD', 'HDFC Bank', '2378', 0, current_date - 30);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN.bajaj}', '${tenant}', '${ACCT}', current_date - 5, '${LINE.bajaj}', 0, 500000, 'csv_upload'),
      ('${TXN.tata}',  '${tenant}', '${ACCT}', current_date - 2, '${LINE.tata}', 25000, 0, 'csv_upload');
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${owners[0].trim()}', 'role', 'authenticated')::text, true);
    select public.book_bank_advance('${TXN.bajaj}', 'Bajaj Finance', 'received', 'Card test R-2378 — local only');
    select public.book_bank_advance('${TXN.tata}', 'Tata Capital', 'received', 'Card test R-2378 — local only');
    commit;`);
}

test.describe("R-2378 card test", () => {
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

  test("Step 1: Banking → the loan line booked through Loan / EMI shows \"Loan received · Bajaj Finance\", not manual", async () => {
    await openAppPage(page, `/accounting/banking/${ACCT}`);
    const bajaj = page.locator(`tr[data-txn-id="${TXN.bajaj}"]`);
    await expect(bajaj).toBeVisible({ timeout: 60_000 });
    await expect(bajaj.getByText("Loan received", { exact: true })).toBeVisible();
    const link = bajaj.getByTestId("line-booking");
    await expect(link).toHaveText("Bajaj Finance");
    await expect(link).toHaveAttribute("href", "/accounting/balance-sheet");
    await expect(bajaj.getByText("Reconciled", { exact: true })).toHaveCount(0);

    const tata = page.locator(`tr[data-txn-id="${TXN.tata}"]`);
    await expect(tata.getByText("Loan repaid", { exact: true })).toBeVisible();
    await expect(tata.getByTestId("line-booking")).toHaveText("Tata Capital");
  });
});
