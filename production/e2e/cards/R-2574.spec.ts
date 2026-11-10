/**
 * Card test — R-2574 "Undo this sale on a bank line split into several receipts" (R-2550 card tests).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2574`.
 *
 * Data (made fresh on every run and removed again after it — E2E Test Co + the local docker DB only):
 *   · CT R2574 Split Pvt Ltd with a ₹17,700 money-in line, booked (as the reconcile drawer's "A new sale"
 *     with two sales does — reconcile_bank_credit_split) as sale A 1 × ₹10,000 + 18% = ₹11,800 and sale B
 *     1 × ₹5,000 + 18% = ₹5,900, each with a yearly subscription.
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
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const CUST = "c2574000-0000-4000-8000-000000000001";
const TXN = "c2574000-0000-4000-8000-000000000011";
const NAME = "CT R2574 Split Pvt Ltd";
const LINE = "CT R2574 SPLIT PVT LTD";

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
  if (why || !c) throw new Error(`R-2574 card test refuses to write test data: ${why}`);
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

/** The sales this card's line made (quote ids), read before the line is freed or after. */
function quotesOfCustomer(c: string, tenant: string): string[] {
  return psql(c, `select id from public.quotes where tenant_id = '${tenant}' and customer_id = '${CUST}' order by id;`);
}

/** What an earlier run (or this one) made from the card's customer and line — and nothing else. */
function clearSql(tenant: string, quotes: string[]): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  const q = quotes.length ? `array[${quotes.map((x) => `'${x}'`).join(",")}]::text[]` : "'{}'::text[]";
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], array['${TXN}']::uuid[], ${q}, '{}'::text[], '{}'::text[], array['${CUST}']);`,
  ];
}

const SALES = JSON.stringify([
  { lines: [{ item_id: null, name: "CT R2574 Sale A", qty: 1, rate: 10000, cost: 0, commitment: "annual_yearly", domain: "a.ct2574split.example" }],
    billing_cycle: "yearly", create_subscription: true, amount: 11800 },
  { lines: [{ item_id: null, name: "CT R2574 Sale B", qty: 1, rate: 5000, cost: 0, commitment: "annual_yearly", domain: "b.ct2574split.example" }],
    billing_cycle: "yearly", create_subscription: true, amount: 5900 },
]);

function seed(): void {
  const c = container();
  const tenant = tenantId(c);
  const [owner] = psql(c, `select id from public.users where tenant_id = '${tenant}' and role = 'owner' and is_active order by created_at limit 1;`);
  if (!owner) throw new Error("E2E Test Co has no owner login");
  psql(c, [
    ...clearSql(tenant, quotesOfCustomer(c, tenant)),
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', :'tenant', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2574.example', 'ct2574split.example', 'Card test R-2574 — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002574-${LINE}-TWO SALES', 0, 17700, 'CT-N2025442574011', 'csv_upload');`,
    /* Booked as the owner, the way the reconcile drawer's "A new sale" (two sales) books it. */
    `select set_config('request.jwt.claims', json_build_object('sub', '${owner.trim()}', 'role', 'authenticated')::text, true);`,
    "set local role authenticated;",
    `select public.reconcile_bank_credit_split('${TXN}', '${CUST}', '[]'::jsonb, '${SALES}'::jsonb, null) is not null;`,
    "reset role;",
    "commit;",
  ].join("\n"));
}

function clearAll(): void {
  const c = container();
  const tenant = tenantId(c);
  psql(c, [...clearSql(tenant, quotesOfCustomer(c, tenant)), "commit;"].join("\n"));
}

/** Seed ONCE per run (a failed step restarts the worker and runs beforeAll again). */
function seedOncePerRun(): void {
  const marker = path.join(os.tmpdir(), `card-test-R-2574-${process.ppid}.seeded`);
  if (fs.existsSync(marker)) return;
  seed();
  fs.writeFileSync(marker, new Date().toISOString());
}

/** The line's receipts still on it, and the live subscriptions of its sales. */
function lineState(): { matched: boolean; receipts: number; liveSubs: number } {
  const c = container();
  const [row] = psql(c, `select (select matched_to_id is not null from public.bank_transactions where id = '${TXN}')
    || '|' || (select count(*) from public.payments where bank_txn_id = '${TXN}')
    || '|' || (select count(*) from public.subscriptions where customer_id = '${CUST}' and status <> 'cancelled');`);
  const [m, r, s] = row.split("|");
  return { matched: m === "true", receipts: Number(r), liveSubs: Number(s) };
}

test.describe("R-2574 — undo-sale on a bank line split into several receipts", () => {
  onlyInCardTests();
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAll();   // leave no test data behind
  });

  test("Step 1: a credit line booked as two new sales → both receipts on the line", async () => {
    const s = lineState();
    expect(s.matched, "the line is reconciled").toBe(true);
    expect(s.receipts, "receipts on the line").toBe(2);
    expect(s.liveSubs, "subscriptions of the two sales").toBe(2);
  });

  test("Step 2: Un-reconcile → no 'Undo this sale'; the dialog lists this sale AND the other sale, each with its page", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/accounting/banking/${ACCT}`);
      const row = page.locator("main table tbody tr").filter({ hasText: LINE }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: "Un-reconcile" }).click();
      const un = page.getByRole("dialog", { name: "Un-reconcile this line?" });
      const alert = un.getByRole("alert");
      await expect(alert).toContainText("The sale cannot be undone from here.", { timeout: 60_000 });
      await expect(alert).toContainText("takes back one sale only");
      const list = un.getByRole("list", { name: "Booked from this bank line" });
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await expect(list).toContainText("₹11,800");
      await expect(list).toContainText("₹5,900");
      await expect(un.getByRole("checkbox")).toHaveCount(0);
      test.info().annotations.push({ type: "note", description: (await alert.innerText()).replace(/\s+/g, " ").slice(0, 400) });
      await un.getByRole("button", { name: "Cancel" }).click();
      await expect(un).toBeHidden({ timeout: 30_000 });
      const s = lineState();
      expect(s, "nothing changed by opening the dialog").toEqual({ matched: true, receipts: 2, liveSubs: 2 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: the server refuses the undo too — no receipt is left on no bank line", async () => {
    const c = container();
    const tenant = tenantId(c);
    const [owner] = psql(c, `select id from public.users where tenant_id = '${tenant}' and role = 'owner' and is_active order by created_at limit 1;`);
    psql(c, [
      "begin;",
      `select set_config('request.jwt.claims', json_build_object('sub', '${owner.trim()}', 'role', 'authenticated')::text, true);`,
      "set local role authenticated;",
      `do $$ begin perform public.unreconcile_bank_receipt('${TXN}', true); exception when check_violation then if sqlerrm not like '%takes back one sale only%' then raise; end if; end $$;`,
      "commit;",   // refused by the split-line block (any other refusal fails here); one that ran shows below
    ].join("\n"));
    const s = lineState();
    expect(s, "both receipts still on the line, both subscriptions live").toEqual({ matched: true, receipts: 2, liveSubs: 2 });
  });
});
