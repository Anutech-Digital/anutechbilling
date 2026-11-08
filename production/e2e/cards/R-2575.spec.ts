/**
 * Card test — R-2575 "Cash flow: loans GIVEN (and advances given) filed under Financing — AS-3 says
 * Investing".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2575`.
 *
 * Data (E2E Test Co + the local docker DB only, made fresh on every run and removed after it):
 * a bank account "CT R2575 Current ··2575" and one ₹50,000 payout written by the same RPC
 * Loans given → Give loan calls (give_loan), as the company's owner. The Cash Flow page sums the
 * whole company, so the test reads the Investing / Financing rows BEFORE the loan and after it:
 * Investing cash-out must grow by exactly ₹50,000 and Financing must not move.
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
const ACCT = "c2575000-0000-4000-8000-000000000a01";
const BORROWER = "CT R2575 Ravi";
const AMOUNT = 50_000;

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
  if (why || !c) throw new Error(`R-2575 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const CLEAN = `
  delete from public.loans_given where paid_from_account_id = '${ACCT}';
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';`;

function clean(): void {
  psql(container(), `begin; ${CLEAN} commit;`);
}

function giveLoan(): void {
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
      values ('${ACCT}', '${tenant}', 'CT R2575 Current', 'HDFC Bank', '2575', 100000, current_date - 30);
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${owners[0].trim()}', 'role', 'authenticated')::text, true);
    select public.give_loan('${BORROWER}', 'person', ${AMOUNT}, current_date - 3, '${ACCT}');
    commit;`);
}

/** Cash in / cash out of one row of "Cash flow statement — by activity" (0 when the row is absent). */
async function activityRow(page: Page, heading: RegExp): Promise<{ cashIn: number; cashOut: number }> {
  const row = page.locator("tr", { hasText: heading });
  if ((await row.count()) === 0) return { cashIn: 0, cashOut: 0 };
  const num = async (i: number) => Number(((await row.first().locator("td").nth(i).innerText()) || "").replace(/[^0-9.]/g, "")) || 0;
  return { cashIn: await num(1), cashOut: await num(2) };
}

async function openCashFlow(page: Page): Promise<void> {
  await openAppPage(page, "/accounting/cash-flow");
  await expect(page.getByText("Cash flow statement — by activity (direct method)")).toBeVisible({ timeout: 60_000 });
}

test.describe("R-2575 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let before = { investing: { cashIn: 0, cashOut: 0 }, financing: { cashIn: 0, cashOut: 0 } };
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    clean();
    page = await pageAs(browser, baseURL, "owner");
    await openCashFlow(page);
    before = { investing: await activityRow(page, /Investing activities \(/), financing: await activityRow(page, /Financing activities \(/) };
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: Accounting → Loans given → Give loan ₹50,000 (the same give_loan the button calls)", async () => {
    giveLoan();
    expect(psql(container(), `select matched_to_type || '|' || debit from public.bank_transactions where bank_account_id = '${ACCT}' and description = 'Loan given: ${BORROWER}';`))
      .toEqual([`loan_given|${AMOUNT}`]);
  });

  test("Step 2: Reports → Cash Flow opens with the statement by activity", async () => {
    await openCashFlow(page);
    await expect(page.locator("tr", { hasText: /Investing activities \(/ })).toBeVisible();
  });

  test("Step 3: the ₹50,000 is under 'Investing activities', not 'Financing'", async () => {
    const investing = await activityRow(page, /Investing activities \(/);
    const financing = await activityRow(page, /Financing activities \(/);
    expect(investing.cashOut - before.investing.cashOut).toBe(AMOUNT);
    expect(financing).toEqual(before.financing);
  });
});
