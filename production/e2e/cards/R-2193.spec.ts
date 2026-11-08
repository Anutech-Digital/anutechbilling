/**
 * Card test — R-2193 "One sale with Monthly-flexible lines + one-time lines (domain/setup): allowed;
 * one-time only on the first part" (R-2550 card tests).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2193` (needs migration 20261107233022 on the local DB —
 * `npm run localhost:update` after the push).
 *
 * Data (made fresh on every run and removed after the last step — E2E Test Co + the local docker DB
 * only), written with the scenario helpers (scripts/dev/scenarios/_common.sql → pg_temp.scn_clear):
 *   · CT R2193 Flex Pvt Ltd (domain ct2193flex.example) and a ₹4,531 money-in line on the scenarios'
 *     account = 10 seats × ₹264 Flexible (monthly) + a ₹1,200 one-time domain, + 18% GST;
 *   · a one-time catalogue row "CT R2193 Domain registration" (removed again after the run).
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
const CUST = "c2193000-0000-4000-8000-000000000001";
const TXN = "c2193000-0000-4000-8000-000000000011";
const ITEM = "CT-R2193-DOMAIN";
const NAME = "CT R2193 Flex Pvt Ltd";
const LINE = "CT R2193 FLEX PVT LTD";

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
  if (why || !c) throw new Error(`R-2193 card test refuses to write test data: ${why}`);
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

/** What an earlier run (or this one) made from the card's customer, line and catalogue row — nothing else. */
function clearSql(tenant: string): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], array['${TXN}']::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], array['${CUST}']);`,
    `delete from public.items where id = '${ITEM}' and tenant_id = :'tenant';`,
  ];
}

function seed(): void {
  const c = container();
  const tenant = tenantId(c);
  psql(c, [
    ...clearSql(tenant),
    `insert into public.items (id, tenant_id, vendor, name, msrp, wholesale, kind, item_type, is_active, prices) values
      ('${ITEM}', :'tenant', 'domain', 'CT R2193 Domain registration', 1200, 800, 'main', 'one_time', true, '{}'::jsonb);`,
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', :'tenant', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2193.example', 'ct2193flex.example', 'Card test R-2193 — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002193-${LINE}-FLEX', 0, 4531, 'CT-N2025442193011', 'csv_upload');`,
    "commit;",
  ].join("\n"));
}

function clearAll(): void {
  const c = container();
  psql(c, [...clearSql(tenantId(c)), "commit;"].join("\n"));
}

/* One run = one data set (R-2572 — see R-2179.spec.ts): seeded once per runner, cleared after the last step. */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2193-${process.ppid}.seeded`);
const LAST_STEP = "Step 3";

function seedOncePerRun(): void {
  if (fs.existsSync(RUN_MARKER)) return;
  seed();
  fs.writeFileSync(RUN_MARKER, new Date().toISOString());
}

function clearAfterLastStep(stepsRun: readonly string[]): void {
  if (!stepsRun.some((t) => t.startsWith(LAST_STEP))) return;
  clearAll();
  fs.rmSync(RUN_MARKER, { force: true });
}

/** The new sale's quote, read off the reconciled line's receipt. */
function saleQuote(c: string): string {
  const [q] = psql(c, `select p.quote_id from public.bank_transactions t join public.payments p on p.id::text = t.matched_to_id where t.id = '${TXN}';`);
  return q ?? "";
}

test.describe("R-2193 — Monthly flex + one-time on one sale", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(480_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  const stepsRun: string[] = [];
  test.afterEach(() => {
    stepsRun.push(test.info().title);
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAfterLastStep(stepsRun);
  });

  test("Step 1: Banking → money-in line → A new sale → Flexible (monthly) seats + one-time domain → Save works", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/accounting/banking/${ACCT}`);
      const row = page.locator("main table tbody tr").filter({ hasText: LINE }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: /^Reconcile$/ }).click();
      const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await pickPayingCustomer(dlg, NAME);
      await dlg.getByRole("button", { name: /^A new sale/ }).click();

      // Line 1: the domain, one-time (typed FIRST on purpose — the server stores the seats first).
      await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "CT R2193 Domain registration · domain" });
      await dlg.getByLabel(/^Unit price/).first().fill("1200");
      // Line 2: 10 seats Flexible (monthly) at ₹264.
      await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "E2E Google Workspace Business Starter · google" });
      await dlg.getByRole("combobox", { name: "Commitment" }).nth(1).selectOption({ label: "Flexible (monthly)" });
      await dlg.getByRole("spinbutton", { name: "Seats" }).fill("10");   // the domain line asks "Quantity", not seats
      await dlg.getByLabel(/^Unit price/).nth(1).fill("264");

      // No "one billing term" refusal; later months are the seats alone.
      await expect(dlg.getByText(/cannot be on one sale/)).toHaveCount(0);
      await expect(dlg.getByText(/Then ₹3,115 every month/)).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: /^Record sale & reconcile/ }).click();
      await expect(dlg.getByRole("region", { name: "Done — this bank line is reconciled" })).toBeVisible({ timeout: 240_000 });

      const c = container();
      const q = saleQuote(c);
      expect(q, "the new sale's quote").toBeTruthy();
      const [quote] = psql(c, `select amount || '|' || billing_cycle || '|' || (line_items->0->>'commitment') || '|' || (select count(*) from public.subscriptions s where s.quote_id = q.id)
                                 from public.quotes q where q.id = '${q}';`);
      expect(quote, "one sale ₹4,531, monthly, seats first, one subscription").toBe("4531|monthly|monthly|1");
      test.info().annotations.push({ type: "note", description: `One sale ${q}: ₹4,531 (seats + domain)` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: invoice 1 has both lines (seats + domain), ₹4,531, Paid", async ({ browser, baseURL }) => {
    const c = container();
    const q = saleQuote(c);
    expect(q, "Step 1 made the sale").toBeTruthy();
    const [inv] = psql(c, `select i.id || '|' || i.amount || '|' || i.status || '|' || jsonb_array_length(i.line_items)
                             from public.invoices i join public.subscription_billings b on b.invoice_id = i.id
                             join public.subscriptions s on s.id = b.subscription_id
                            where s.quote_id = '${q}' order by b.term_start limit 1;`);
    expect(inv, "month 1 is invoiced").toBeTruthy();
    const [id, amount, status, lines] = inv.split("|");
    expect(Number(amount)).toBe(4531);
    expect(status).toBe("paid");
    expect(Number(lines)).toBe(2);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/invoices/${id}`);
      await expect(page.getByText(/CT R2193 Domain registration/).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/E2E Google Workspace Business Starter/).first()).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: next month bills only the seats (₹2,640 + GST), not the domain again", async () => {
    const c = container();
    const q = saleQuote(c);
    const [sub] = psql(c, `select mrr || '|' || billing_cycle || '|' || term_months from public.subscriptions where quote_id = '${q}';`);
    expect(sub, "the subscription renews monthly on the seats alone").toBe("2640|monthly|1");
    // The one-time line is on month 1's live invoice, so quote_one_time_lines gives nothing for a later part.
    const [left] = psql(c, `select count(*) from public.quote_one_time_lines('${q}') where taxable > 0;`);
    expect(Number(left), "the domain is not billed again").toBe(0);
  });
});
