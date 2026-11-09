/**
 * Card test — R-2606 "Quote billed in parts: 'Settle ₹X' button + confirm dialog on the quote's money
 * row" (UI of R-2595's settle_quote_part_short). Run: `node scripts/ops/card-tests.mjs R-2606`.
 *
 * Data (made fresh on every run and removed after the last step — E2E Test Co + the local docker DB
 * only), the shape of staging Q-A378-27-0021: customer "CT R2606 Parts Pvt Ltd", quote Q-CT-R2606,
 * annual, billed quarterly, four parts of ₹95,993; Part 1's invoice raised, ₹95,933 received and
 * matched to its own bank line (₹60 short).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUST = "c2606000-0000-4000-8000-000000000001";
const SUB = "c2606000-0000-4000-8000-000000000021";
const BANK = "c2606000-0000-4000-8000-0000000000ba";
const LINE = "c2606000-0000-4000-8000-0000000000d1";
const BILL1 = "c2606000-0000-4000-8000-000000000101";
const QUOTE = "Q-CT-R2606";
const NAME = "CT R2606 Parts Pvt Ltd";

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
  if (why || !c) throw new Error(`R-2606 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function tenantOwner(c: string): { tenant: string; owner: string } {
  const t = psql(c, `select t.id || '|' || (select u.id from public.users u where u.tenant_id = t.id and u.role = 'owner' and u.is_active order by u.created_at limit 1)
                       from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  const [tenant, owner] = t[0].trim().split("|");
  if (!owner) throw new Error("E2E Test Co has no owner user");
  return { tenant, owner };
}

/** Only what this card test made (the part invoice is removed with triggers off — local DB only). */
function clearSql(tenant: string): string {
  return `set local session_replication_role = replica;
          delete from public.bank_receipt_round_offs where tenant_id = '${tenant}' and bank_txn_id = '${LINE}';
          delete from public.payments where tenant_id = '${tenant}' and quote_id = '${QUOTE}';
          delete from public.bank_transactions where tenant_id = '${tenant}' and id = '${LINE}';
          delete from public.invoices where tenant_id = '${tenant}' and (quote_id = '${QUOTE}'
            or id in (select invoice_id from public.subscription_billings where subscription_id = '${SUB}'));
          delete from public.subscription_billings where tenant_id = '${tenant}' and subscription_id = '${SUB}';
          delete from public.support_sync_outbox where tenant_id = '${tenant}' and (subscription_id = '${SUB}' or customer_id = '${CUST}');
          delete from public.panel_account_outbox where tenant_id = '${tenant}' and customer_id = '${CUST}';
          delete from public.subscriptions where tenant_id = '${tenant}' and id = '${SUB}';
          delete from public.quotes where tenant_id = '${tenant}' and id = '${QUOTE}';
          delete from public.bank_accounts where tenant_id = '${tenant}' and id = '${BANK}';
          delete from public.customers where tenant_id = '${tenant}' and id = '${CUST}';
          set local session_replication_role = origin;`;
}

function seed(): void {
  const c = container();
  const { tenant, owner } = tenantOwner(c);
  psql(c, `begin;
    ${clearSql(tenant)}
    insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', '${tenant}', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2606.example', 'ct2606parts.example', 'Card test R-2606 — local only');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status,
                               billing_cycle, line_items, is_add_seats, is_one_off, created_date) values
      ('${QUOTE}', '${tenant}', '${CUST}', '${NAME}', 383972, 325400, 0, 18, 'accepted', 'none', 'quarterly',
       '[{"id":"s","name":"E2E Google Workspace Business Starter","qty":100,"rate":3254,"cost":2500,"commitment":"annual"}]'::jsonb,
       false, false, current_date - 7);
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, domain, plan, vendor, seats, mrr, start_date, renewal_date,
                                      status, term_months, item_id, billing_cycle, quote_id) values
      ('${SUB}', '${tenant}', '${CUST}', '${NAME}', 'ct2606parts.example', 'E2E Google Workspace Business Starter', 'google', 100, 27117,
       current_date - 7, current_date + 358, 'active', 12, 'E2E-GW-STR', 'quarterly', '${QUOTE}');
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
    select ('c2606000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, '${tenant}', '${SUB}', current_date - 7, n,
           current_date - 7 + (n - 1) * 91, current_date - 7 + (n - 1) * 91, current_date - 7 + n * 91 - 1, 81350, 18
      from generate_series(1, 4) n;
    insert into public.bank_accounts (id, tenant_id, name, bank_name) values ('${BANK}', '${tenant}', 'CT R2606 Current', 'CT R2606 Bank');
    select set_config('request.jwt.claims', '{"sub":"${owner}","role":"authenticated"}', true);
    select public.raise_subscription_billing('${BILL1}');
    select public.record_instalment_payment((select invoice_id from public.subscription_billings where id = '${BILL1}'), 95933,
      'bank_transfer', 'CTUTR2606', 'Card test R-2606 — local only', null, 0, current_date - 5, '${BANK}');
    select set_config('request.jwt.claims', '', true);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source, matched_to_type, matched_to_id)
    values ('${LINE}', '${tenant}', '${BANK}', current_date - 5, 'NEFT CT R2606', 'CTUTR2606', 95933, 0, 'manual', 'payment',
      (select p.id::text from public.payments p where p.quote_id = '${QUOTE}' and p.status = 'received' order by p.received_at desc limit 1));
    commit;`);
}

function clearAll(): void {
  const c = container();
  psql(c, `begin; ${clearSql(tenantOwner(c).tenant)} commit;`);
}

/* One run = one data set (R-2572): seeded once per runner, cleared after the last step. */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2606-${process.ppid}.seeded`);
const LAST_STEP = "Step 3";

test.describe("R-2606 — Settle ₹60 as round-off on a quote billed in parts", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON || fs.existsSync(RUN_MARKER)) return;
    seed();
    fs.writeFileSync(RUN_MARKER, new Date().toISOString());
  });
  const stepsRun: string[] = [];
  test.afterEach(() => {
    stepsRun.push(test.info().title);
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON || !stepsRun.some((t) => t.startsWith(LAST_STEP))) return;
    clearAll();
    fs.rmSync(RUN_MARKER, { force: true });
  });

  test("Step 1: manager sees 'Record ₹60 balance' but no Settle button (owner / accountant only)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "manager");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await expect(page.getByRole("button", { name: "Record ₹60 balance" })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: /Settle ₹60/ })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: owner clicks 'Settle ₹60 as round-off', the dialog names the ledger + bank line, Settle closes the short", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, `/quotes/${QUOTE}`);
      await expect(page.getByText(/Part 1 of 4 received \(₹60 short\)/).first()).toBeVisible({ timeout: 60_000 });
      /* the button waits for the signed-in role (owner / accountant) */
      const settle = page.getByRole("button", { name: "Settle ₹60 as round-off" });
      await expect(settle).toBeVisible({ timeout: 60_000 });
      await settle.click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toContainText("Settle ₹60 as round-off?");
      await expect(dlg).toContainText("Bank Charges · Settlement short of receipt");
      await expect(dlg).toContainText(/₹95,933 credited on/, { timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await dlg.getByRole("button", { name: "Settle ₹60" }).click();
      await expect(page.getByText(/₹60 settled as round-off/).first()).toBeVisible({ timeout: 30_000 });
      await expect(dlg).toHaveCount(0);
      await expect(page.getByText(/₹60 short/)).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("button", { name: /Settle ₹60/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Record ₹60 balance" })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Part 1 is fully received, Part 2 untouched, the ₹60 is booked once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      const list = page.getByTestId("instalment-list");
      await expect(list).toBeVisible({ timeout: 60_000 });
      await expect(list.locator("li").nth(0)).toContainText(/Part 1 of 4.*₹95,993/);
      await expect(list.locator("li").nth(0)).not.toContainText(/short/);
      await expect(list.locator("li").nth(1)).toContainText(/Part 2 of 4.*₹95,993/);
      const c = container();
      const [roundOff, part2, inv1] = psql(c, `
        select coalesce(sum(amount), 0) from public.bank_receipt_round_offs where bank_txn_id = '${LINE}';
        select coalesce(invoice_id, 'none') from public.subscription_billings where subscription_id = '${SUB}' and period_index = 2;
        select i.status || '/' || i.paid_amount from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = '${BILL1}';`);
      expect(Number(roundOff)).toBe(60);
      expect(part2).toBe("none");
      expect(inv1).toMatch(/^paid\/95993/);
    } finally {
      await page.context().close();
    }
  });
});
