/**
 * Card test — R-2588 "Vendor advance ki TDS bill par credit ho — Apply advance par TDS dobara na kate"
 * (R-1916 slice 2; R-2550 card tests). Run: `node scripts/ops/card-tests.mjs R-2588`.
 *
 * Data (made fresh on every run and removed again after it — E2E Test Co + the local docker DB only):
 *   · vendor "CT R2588 Design Studio" with a ₹90,000 money-out line booked as an advance with TDS
 *     ₹10,000 194J(b) — reconcile_bank_debit_to_vendor, the call the Reconcile sheet's Save makes;
 *   · its ₹1,00,000 bill CT-R2588-1 on Expenses, recorded WITH TDS ₹10,000 (194J(b)), unpaid.
 * Step 1 is clicked on the Expenses page like the owner; steps 2–3 read the books the screen shows.
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
const VENDOR = "c2588000-0000-4000-8000-000000000001";
const TXN = "c2588000-0000-4000-8000-000000000011";
const BILL = "EXP-CT-R2588-1";
const BILL_NO = "CT-R2588-1";
const NAME = "CT R2588 Design Studio";

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
  if (why || !c) throw new Error(`R-2588 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function tenantAndOwner(c: string): { tenant: string; owner: string } {
  const t = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  const [owner] = psql(c, `select id from public.users where tenant_id = '${t[0].trim()}' and role = 'owner' and is_active order by created_at limit 1;`);
  if (!owner) throw new Error("E2E Test Co has no owner login");
  return { tenant: t[0].trim(), owner: owner.trim() };
}

function clearSql(tenant: string): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, array['${VENDOR}']::uuid[], array['${TXN}']::uuid[], array['${BILL}']::text[], '{}'::text[], '{}'::text[], '{}'::text[]) is not null;`,
  ];
}

/** Balance Sheet TDS payable (dues_vendor_tds) as the owner sees it today. */
function tdsPayable(c: string, owner: string): number {
  const [v] = psql(c, [
    "begin;",
    `select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true) is not null;`,
    "set local role authenticated;",
    "select dues_vendor_tds from public.report_balance_sheet();",
    "rollback;",
  ].join("\n")).filter((l) => /^-?\d+$/.test(l.trim()));
  return Number(v);
}

const BASE_FILE = path.join(os.tmpdir(), `card-test-R-2588-${process.ppid}.base`);

function seed(): void {
  const c = container();
  const { tenant, owner } = tenantAndOwner(c);
  psql(c, [...clearSql(tenant), "commit;"].join("\n"));
  fs.writeFileSync(BASE_FILE, String(tdsPayable(c, owner)));
  psql(c, [
    `\\set tenant '${tenant}'`,
    "begin;",
    `insert into public.vendors (id, tenant_id, name, pan, default_category, notes) values
      ('${VENDOR}', :'tenant', '${NAME}', 'ABCPD2588K', 'Professional Fees', 'Card test R-2588 — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN}', :'tenant', '${ACCT}', current_date - 5, 'NEFT DR-HDFC0002588-CT R2588 DESIGN STUDIO-ADVANCE', 90000, 0, 'CT-N2025442588011', 'csv_upload');`,
    `insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section, description) values
      ('${BILL}', :'tenant', 'Professional Fees', '${NAME}', '${VENDOR}', current_date - 1, 100000, 0, 'none', '${BILL_NO}', false, null, 10000, '194JB', 'Card test R-2588 bill (with TDS)');`,
    `select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true) is not null;`,
    "set local role authenticated;",
    `select public.reconcile_bank_debit_to_vendor(p_txn_id => '${TXN}', p_vendor_id => '${VENDOR}', p_new_vendor => null, p_items => '[]'::jsonb,
       p_new_bill => null, p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
       p_advance_tds => 10000, p_advance_tds_section => '194JB', p_advance_tds_override_reason => null) is not null;`,
    "reset role;",
    "commit;",
  ].join("\n"));
}

function seedOncePerRun(): void {
  const marker = path.join(os.tmpdir(), `card-test-R-2588-${process.ppid}.seeded`);
  if (fs.existsSync(marker)) return;
  seed();
  fs.writeFileSync(marker, new Date().toISOString());
}

function clearAll(): void {
  const c = container();
  const { tenant } = tenantAndOwner(c);
  psql(c, [...clearSql(tenant), "commit;"].join("\n"));
}

test.describe("R-2588 — Apply advance credits the advance's TDS on the bill", () => {
  onlyInCardTests();
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAll();
  });

  test("Step 1: Expenses → bill CT-R2588-1 (₹1,00,000, TDS ₹10,000) → 'Apply advance ₹1,00,000' → bill paid, toast says the TDS was already deducted", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/expenses");
      const row = page.locator("main table tbody tr").filter({ hasText: NAME }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      const apply = row.getByRole("button", { name: /^Apply advance/ });
      await expect(apply).toHaveText(/Apply advance\s*₹1,00,000/, { timeout: 60_000 });
      await apply.click();
      await expect(page.getByText(/TDS ₹10,000 was already deducted on the advance — not taken again on bill CT-R2588-1/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/bill CT-R2588-1 is paid/).first()).toBeVisible();
      await expect(row.getByText(/Advance ₹1,00,000 applied/)).toBeVisible({ timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the books — bill paid, nothing stuck in Prepaid, one TDS row (26Q) for the vendor", async () => {
    const c = container();
    const [row] = psql(c, `select e.paid || '|' || e.tds_amount || '|' || e.advance_applied
        || '|' || (select coalesce(sum(total_amount - consumed_amount), 0) from public.prepaid_advances where vendor_id = '${VENDOR}')
        || '|' || ((select count(*) from public.expenses where vendor_id = '${VENDOR}' and tds_amount > 0)
                   + (select count(*) from public.bank_vendor_payment_lines where vendor_id = '${VENDOR}' and tds_amount > 0))
      from public.expenses e where e.id = '${BILL}';`);
    const [paid, tds, applied, left, rows] = row.split("|");
    expect({ paid, tds: Number(tds), applied: Number(applied), left: Number(left), rows: Number(rows) })
      .toEqual({ paid: "true", tds: 0, applied: 100000, left: 0, rows: 1 });
  });

  test("Step 3: Balance Sheet TDS payable went up by ₹10,000 only (not ₹20,000)", async () => {
    const c = container();
    const { owner } = tenantAndOwner(c);
    const base = Number(fs.readFileSync(BASE_FILE, "utf8"));
    expect(tdsPayable(c, owner) - base).toBe(10000);
  });
});
