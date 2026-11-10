/**
 * Card test — R-2179 "Reconcile gaps from the August run" (R-2550 card tests).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2179`.
 *
 * Data (made fresh on every run and removed again after it — E2E Test Co + the local docker DB only),
 * written with the scenario helpers (scripts/dev/scenarios/_common.sql → pg_temp.scn_clear):
 *   · CT R2179 Seats Pvt Ltd (domain ct2179seats.example) with a yearly E2E Google Workspace Business
 *     Starter subscription of 10 seats filed with NO domain of its own (the August case), and an
 *     add-seats quote CT-R2179-ADD: 2 seats × ₹15,000 + 18% = ₹35,400; a ₹34,000 money-in line.
 *   · CT R2179 Sale Pvt Ltd with a ₹1,85,850 money-in line (50 × ₹3,150 M365 Basic + 18%).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs, pickPayingCustomer } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const CUST = { seats: "c2179000-0000-4000-8000-000000000001", sale: "c2179000-0000-4000-8000-000000000002" };
const TXN = { seats: "c2179000-0000-4000-8000-000000000011", sale: "c2179000-0000-4000-8000-000000000012" };
const SUB = "c2179000-0000-4000-8000-000000000021";
const QUOTE = "CT-R2179-ADD";
const NAME = { seats: "CT R2179 Seats Pvt Ltd", sale: "CT R2179 Sale Pvt Ltd" };
const LINE = { seats: "CT R2179 SEATS PVT LTD", sale: "CT R2179 SALE PVT LTD" };

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
  if (why || !c) throw new Error(`R-2179 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function tenantId(c: string): string {
  const t = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  return t[0].trim();
}

/** What an earlier run (or this one) made from the card's customers and lines — and nothing else. */
function clearSql(tenant: string): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], array['${TXN.seats}','${TXN.sale}']::uuid[], array['${QUOTE}']::text[], '{}'::text[], '{}'::text[], array['${CUST.seats}','${CUST.sale}']);`,
  ];
}

function seed(): void {
  const c = container();
  const tenant = tenantId(c);
  psql(c, [
    ...clearSql(tenant),
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST.seats}', :'tenant', '${NAME.seats}', 'Maharashtra', '27', 'business', 'accounts@ct2179a.example', 'ct2179seats.example', 'Card test R-2179 — local only'),
      ('${CUST.sale}',  :'tenant', '${NAME.sale}',  'Maharashtra', '27', 'business', 'accounts@ct2179b.example', 'ct2179sale.example',  'Card test R-2179 — local only');`,
    `insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, status, term_months, item_id, billing_cycle) values
      ('${SUB}', :'tenant', '${CUST.seats}', '${NAME.seats}', 'E2E Google Workspace Business Starter', 'google', 10, 2500,
       current_date - 100, current_date + 265, 'active', 12, 'E2E-GW-STR', 'yearly');`,
    `insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status,
                                billing_cycle, line_items, is_add_seats, add_seats_subscription_id, is_one_off, created_date) values
      ('${QUOTE}', :'tenant', '${CUST.seats}', '${NAME.seats}', 35400, 30000, 0, 18, 'accepted', 'awaiting', 'yearly',
       '[{"name":"E2E Google Workspace Business Starter · 2 more seats (pro-rata)","qty":2,"rate":15000,"commitment":"annual_yearly"}]'::jsonb,
       true, '${SUB}', false, current_date - 3);`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN.seats}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002179-${LINE.seats}-SEATS', 0, 34000, 'CT-N2025442179011', 'csv_upload'),
      ('${TXN.sale}',  :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002179-${LINE.sale}-M365',   0, 185850, 'CT-N2025442179012', 'csv_upload');`,
    "commit;",
  ].join("\n"));
}

function clearAll(): void {
  const c = container();
  psql(c, [...clearSql(tenantId(c)), "commit;"].join("\n"));
}

/**
 * One run = one data set (R-2572). A failed step makes Playwright start a NEW worker, which runs
 * beforeAll and afterAll again — so the data is seeded once per run (marker file named after the
 * runner, the workers' parent) and removed only after the LAST step has run, never when an earlier
 * step's worker stops (7 Nov run #2: Step 1 failed → afterAll wiped the data → Steps 2 and 3 found none).
 * The next run's seed clears whatever a stopped run left (scn_clear in clearSql).
 */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2179-${process.ppid}.seeded`);
const LAST_STEP = "Step 3";

function seedOncePerRun(): void {
  if (fs.existsSync(RUN_MARKER)) return;
  seed();
  fs.writeFileSync(RUN_MARKER, new Date().toISOString());
}

/** Clean up only when this worker ran the last step (pass, fail or skip). */
function clearAfterLastStep(stepsRun: readonly string[]): void {
  if (!stepsRun.some((t) => t.startsWith(LAST_STEP))) return;
  clearAll();
  fs.rmSync(RUN_MARKER, { force: true });
}

test.describe("R-2179 — reconcile gaps from the August run", () => {
  onlyInCardTests();
  test.setTimeout(480_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  const stepsRun: string[] = [];
  test.afterEach(() => {
    stepsRun.push(test.info().title);
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAfterLastStep(stepsRun);   // leave no test data behind — after the last step only
  });

  test("Step 1: +2 seats quote ₹35,400 paid ₹34,000 from a bank line → GST invoice exists, ₹1,400 due", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/accounting/banking/${ACCT}`);
      const row = page.locator("main table tbody tr").filter({ hasText: LINE.seats }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: /^Reconcile$/ }).click();
      const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await pickPayingCustomer(dlg, NAME.seats);
      await dlg.getByRole("button", { name: /^An open quote \/ invoice/ }).click();
      await dlg.getByRole("radiogroup", { name: "Open quotes and invoices" }).getByRole("radio").filter({ hasText: /2 more seats|Add seats|Extra seats/i }).first().click();
      // R-2558 (7 Nov): a ₹1,400 gap (4% — could be TDS) is no longer pre-set to Part payment; the owner says why.
      const part = dlg.getByRole("group", { name: "Why less was received" }).getByRole("button", { name: "Part payment — ₹1,400 stays due" });
      if ((await part.getAttribute("aria-pressed")) !== "true") await part.click();
      await page.getByRole("button", { name: `Record ₹34,000 on ${QUOTE} & reconcile` }).click();
      await expect(dlg.getByRole("region", { name: "Done — this bank line is reconciled" })).toBeVisible({ timeout: 240_000 });

      const c = container();
      const [inv] = psql(c, `select q.invoice_id || '|' || i.amount || '|' || i.net_payable || '|' || i.status from public.quotes q join public.invoices i on i.id = q.invoice_id where q.id = '${QUOTE}';`);
      expect(inv, "the add-seats quote has a GST invoice").toBeTruthy();
      const [id, amount, due, status] = inv.split("|");
      expect(Number(amount)).toBe(35400);
      expect(Number(due)).toBe(1400);
      expect(["pending", "overdue"]).toContain(status);
      await openAppPage(page, `/invoices/${id}`);
      await expect(page.getByText(/₹1,400/).first()).toBeVisible({ timeout: 60_000 });
      test.info().annotations.push({ type: "note", description: `Invoice ${id}: ₹${amount}, ₹${due} due (${status})` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: A new sale from a bank line → Un-reconcile → undo the sale → no live quote / invoice / subscription, line Unmatched", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/accounting/banking/${ACCT}`);
      let row = page.locator("main table tbody tr").filter({ hasText: LINE.sale }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: /^Reconcile$/ }).click();
      const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await pickPayingCustomer(dlg, NAME.sale);
      await dlg.getByRole("button", { name: /^A new sale/ }).click();
      await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "E2E Microsoft 365 Business Basic · microsoft" });
      await dlg.getByRole("combobox", { name: "Commitment" }).selectOption({ label: "Annual commitment" });
      await dlg.getByLabel(/^Seats/).fill("50");
      await dlg.getByLabel(/^Unit price/).fill("3150");
      await page.getByRole("button", { name: /^Record sale & reconcile/ }).click();
      await expect(dlg.getByRole("region", { name: "Done — this bank line is reconciled" })).toBeVisible({ timeout: 240_000 });

      const c = container();
      const [q] = psql(c, `select p.quote_id from public.bank_transactions t join public.payments p on p.id::text = t.matched_to_id where t.id = '${TXN.sale}';`);
      expect(q, "the new sale's quote").toBeTruthy();

      await openAppPage(page, `/accounting/banking/${ACCT}`);
      row = page.locator("main table tbody tr").filter({ hasText: LINE.sale }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: "Un-reconcile" }).click();
      const un = page.getByRole("dialog", { name: "Un-reconcile this line?" });
      await expect(un.getByRole("checkbox")).toBeChecked({ timeout: 60_000 });
      await expect(un.getByText(/cancelled — out of MRR and renewals/)).toBeVisible();
      await expect(un.getByText(new RegExp(`Quote ${q} cancelled`))).toBeVisible();
      await un.getByRole("button", { name: "Un-reconcile & undo sale" }).click();
      await expect(un).toBeHidden({ timeout: 60_000 });
      await expect(row.getByRole("button", { name: /^Reconcile$/ })).toBeVisible({ timeout: 60_000 });

      const [left] = psql(c, `select (select status::text from public.quotes where id = '${q}')
        || '|' || (select count(*) from public.subscriptions where quote_id = '${q}' and status <> 'cancelled')
        || '|' || (select count(*) from public.payments where quote_id = '${q}')
        || '|' || coalesce((select string_agg(distinct cn.invoice_id, ',') from public.credit_notes cn join public.quotes qq on qq.invoice_id = cn.invoice_id where qq.id = '${q}'), 'none');`);
      const [status, liveSubs, receipts, credited] = left.split("|");
      expect(status, "quote").toBe("rejected");
      expect(Number(liveSubs), "live subscriptions left").toBe(0);
      expect(Number(receipts), "receipts left").toBe(0);
      expect(credited, "the invoice is credit-noted").not.toBe("none");
      test.info().annotations.push({ type: "note", description: `Sale ${q} undone: quote ${status}, invoice ${credited} credit-noted, no receipt, no live subscription` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Opening subscription for a product + domain the customer already has → warning with seats, renewal and a link", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/subscriptions", /^Subscriptions$/);
      await page.getByRole("button", { name: "Add Subscription" }).click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await dlg.locator("#custName").fill("CT R2179 Seats");
      // The customer search answers slowly on a busy local server (7 Nov run: >10 s) — wait for the match first.
      const match = dlg.getByRole("button", { name: new RegExp(NAME.seats) }).first();
      await expect(match).toBeVisible({ timeout: 60_000 });
      await match.click();
      await dlg.getByRole("button", { name: /Opening — already billed/ }).click();
      await dlg.locator("#planSelect").click();
      await page.getByRole("option", { name: /E2E Google Workspace Business Starter/ }).click();
      const alert = dlg.getByRole("alert").filter({ hasText: "already has" });
      await expect(alert).toContainText(/This customer already has E2E Google Workspace Business Starter on ct2179seats\.example \(1[02] seats, renews \d{1,2} \w{3} \d{4}\) — use Manage seats or Correct details instead\./, { timeout: 60_000 });
      await expect(dlg.getByRole("button", { name: "Open existing subscription" })).toBeVisible();
      test.info().annotations.push({ type: "note", description: (await alert.innerText()).replace(/\s+/g, " ").slice(0, 300) });
      await dlg.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.context().close();
    }
  });
});
