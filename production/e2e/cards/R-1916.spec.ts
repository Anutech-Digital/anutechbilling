/**
 * Card test — R-1916 "Vendor advance par TDS (194C/194J) — TDS payable / 26Q mein aaye" (slice 1; R-2550
 * card tests, written with R-2588). Run: `node scripts/ops/card-tests.mjs R-1916`.
 *
 * Data (made fresh on every run and removed again after it — E2E Test Co + the local docker DB only):
 *   · vendor "CT R1916 Design Studio" (PAN, professional fees) and a ₹90,000 money-out line on the
 *     scenario bank account. Step 1 reconciles it on the Banking page like the owner: Vendor →
 *     advance ₹90,000 → TDS 194J(b) → Save.
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
const VENDOR = "c1916000-0000-4000-8000-000000000001";
const TXN = "c1916000-0000-4000-8000-000000000011";
const NAME = "CT R1916 Design Studio";
const LINE = "CT R1916 DESIGN STUDIO";

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
  if (why || !c) throw new Error(`R-1916 card test refuses to write test data: ${why}`);
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
    `select pg_temp.scn_clear(:'tenant'::uuid, array['${VENDOR}']::uuid[], array['${TXN}']::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[]) is not null;`,
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

const BASE_FILE = path.join(os.tmpdir(), `card-test-R-1916-${process.ppid}.base`);

function seed(): void {
  const c = container();
  const { tenant, owner } = tenantAndOwner(c);
  psql(c, [...clearSql(tenant), "commit;"].join("\n"));
  fs.writeFileSync(BASE_FILE, String(tdsPayable(c, owner)));
  psql(c, [
    `\\set tenant '${tenant}'`,
    "begin;",
    `insert into public.vendors (id, tenant_id, name, pan, default_category, default_tds_section, notes) values
      ('${VENDOR}', :'tenant', '${NAME}', 'ABCPD1916K', 'Professional Fees', '194JB', 'Card test R-1916 — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN}', :'tenant', '${ACCT}', current_date - 4, 'NEFT DR-HDFC0001916-${LINE}-ADVANCE', 90000, 0, 'CT-N2025441916011', 'csv_upload');`,
    "commit;",
  ].join("\n"));
}

function seedOncePerRun(): void {
  const marker = path.join(os.tmpdir(), `card-test-R-1916-${process.ppid}.seeded`);
  if (fs.existsSync(marker)) return;
  seed();
  fs.writeFileSync(marker, new Date().toISOString());
}

function clearAll(): void {
  const c = container();
  const { tenant } = tenantAndOwner(c);
  psql(c, [...clearSql(tenant), "commit;"].join("\n"));
}

test.describe("R-1916 — TDS on a vendor advance paid from the bank", () => {
  onlyInCardTests();
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAll();
  });

  test("Step 1: Banking → the ₹90,000 line → Reconcile → Vendor → advance ₹90,000 + TDS 194J(b) ₹10,000 → Save → 'kept as an advance (₹90,000 paid + TDS ₹10,000)'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/accounting/banking/${ACCT}`);
      const row = page.locator("main table tbody tr").filter({ hasText: LINE }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: /^Reconcile$/ }).click();
      const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
      const vendorPick = dlg.getByRole("combobox", { name: "Vendor paid" });
      const tile = dlg.getByRole("radio", { name: /^Vendor\b/ });
      await expect(vendorPick.or(tile).first()).toBeVisible({ timeout: 60_000 });
      /* The sheet may pick the Vendor tile by itself from the narration a moment later (race) — click the
         tile only while it is still there, then wait for the vendor picker. */
      if (!(await vendorPick.isVisible())) await tile.click({ timeout: 5_000 }).catch(() => { /* already picked */ });
      await expect(vendorPick).toBeVisible({ timeout: 60_000 });
      await vendorPick.selectOption({ label: NAME });
      const adv = dlg.getByRole("spinbutton", { name: "Advance to vendor" });
      await expect(adv).toHaveValue("90000", { timeout: 60_000 });
      await dlg.getByRole("combobox", { name: "Advance TDS section" }).selectOption({ value: "194JB" });
      await expect(dlg.getByRole("spinbutton", { name: "TDS on the advance" })).toHaveValue("10000", { timeout: 30_000 });
      await expect(dlg.getByText(/Advance in the books ₹1,00,000 = ₹90,000 paid \+ TDS ₹10,000/)).toBeVisible();
      await page.getByRole("button", { name: `Record payment ₹90,000 to ${NAME} & reconcile` }).click();
      const done = dlg.getByRole("region", { name: "Done — this bank line is reconciled" });
      await expect(done).toBeVisible({ timeout: 240_000 });
      await expect(done).toContainText("₹1,00,000 kept as an advance");
      await expect(done).toContainText("(₹90,000 paid + TDS ₹10,000)");
      await expect(done).toContainText("TDS ₹10,000");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the advance is ₹1,00,000 in Prepaid; its payment row carries TDS ₹10,000 194J(b)", async () => {
    const c = container();
    const [row] = psql(c, `select pa.total_amount || '|' || l.cash || '|' || l.tds_amount || '|' || l.tds_section
      from public.prepaid_advances pa join public.bank_vendor_payment_lines l on l.prepaid_advance_id = pa.id and l.kind = 'advance'
     where pa.vendor_id = '${VENDOR}';`);
    expect(row).toBe("100000|90000|10000|194JB");
  });

  test("Step 3: Balance Sheet TDS payable went up by ₹10,000", async () => {
    const c = container();
    const { owner } = tenantAndOwner(c);
    const base = Number(fs.readFileSync(BASE_FILE, "utf8"));
    expect(tdsPayable(c, owner) - base).toBe(10000);
  });
});
