/**
 * Card test — R-2538 "Auto TDS row on a sale billed in parts: gross = the part paid" (R-2554).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2538`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only): two test customers and two
 * money-in lines on the scenarios' own bank account "SCN HDFC Current ··7788", written with the
 * scenario helpers (scripts/dev/scenarios/_common.sql → pg_temp.scn_clear removes what an earlier run
 * made from them: quotes, invoices, payments, TDS rows, subscriptions, bank matches):
 *   · CT R2538 Part TDS Pvt Ltd — ₹91,350 in = part 1 (₹78,750 + 18% GST = ₹92,925) less ₹1,575 TDS
 *     (2% of the part's taxable value) → TDS gross must be ₹78,750.
 *   · CT R2538 Full TDS Pvt Ltd — ₹89,775 in = ₹92,925 less ₹3,150 TDS (2% of the WHOLE year's
 *     ₹1,57,500 — the customer deducted on the full contract) → TDS gross must be ₹1,57,500.
 * Each sale is booked through the real Banking → Reconcile → "A new sale (no quote yet)" form:
 * E2E Microsoft 365 Business Basic, 50 seats × ₹3,150/user/year, Annual commitment, Half-yearly,
 * "TDS deducted", section 194C.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const CUST = { part: "c2554000-0000-4000-8000-000000000001", full: "c2554000-0000-4000-8000-000000000002" };
const TXN = { part: "c2554000-0000-4000-8000-000000000011", full: "c2554000-0000-4000-8000-000000000012" };
const NAME = { part: "CT R2538 Part TDS Pvt Ltd", full: "CT R2538 Full TDS Pvt Ltd" };
const LINE = { part: "CT R2538 PART TDS PVT LTD", full: "CT R2538 FULL TDS PVT LTD" };

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
  if (why || !c) throw new Error(`R-2538 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/** Remove what an earlier run made, then two fresh customers + two unreconciled money-in lines. */
function seed(): void {
  const c = container();
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  const tenant = tenants[0].trim();
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  psql(c, [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], array['${TXN.part}','${TXN.full}']::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], array['${CUST.part}','${CUST.full}']);`,
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
      ('${CUST.part}', :'tenant', '${NAME.part}', 'Maharashtra', '27', 'business', 'accounts@ct2538a.example', 'Card test R-2538 (R-2554) — local only'),
      ('${CUST.full}', :'tenant', '${NAME.full}', 'Maharashtra', '27', 'business', 'accounts@ct2538b.example', 'Card test R-2538 (R-2554) — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN.part}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002554-${LINE.part}-M365 H1', 0, 91350, 'CT-N2025542554011', 'csv_upload'),
      ('${TXN.full}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002554-${LINE.full}-M365 H1', 0, 89775, 'CT-N2025542554012', 'csv_upload');`,
    "commit;",
  ].join("\n"));
}

/**
 * Seed ONCE per run: after a failed step Playwright starts a new worker and runs beforeAll again —
 * re-seeding then would undo step 1's sale. The runner (the worker's parent) is the same for the run.
 */
function seedOncePerRun(): void {
  const marker = path.join(os.tmpdir(), `card-test-R-2538-${process.ppid}.seeded`);
  if (fs.existsSync(marker)) return;
  seed();
  fs.writeFileSync(marker, new Date().toISOString());
}

/** Banking → the line → Reconcile → A new sale → 50 × ₹3,150, Half-yearly → TDS deducted (194C) → Record sale. */
async function bookNewSale(page: Page, which: "part" | "full", tds: string): Promise<string> {
  await openAppPage(page, `/accounting/banking/${ACCT}`);
  const row = page.locator("main table tbody tr").filter({ hasText: LINE[which] }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Reconcile$/ }).click();
  const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  // The customer is guessed from the narration; pick it by name anyway (same choice → no change).
  await dlg.getByRole("combobox", { name: "Customer who paid" }).selectOption({ label: NAME[which] });
  await dlg.getByRole("button", { name: /^A new sale/ }).click();
  await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "E2E Microsoft 365 Business Basic · microsoft" });
  await dlg.getByRole("combobox", { name: "Commitment" }).selectOption({ label: "Annual commitment" });
  await dlg.getByLabel(/^Seats/).fill("50");
  await dlg.getByLabel(/^Unit price/).fill("3150");
  await dlg.getByRole("combobox", { name: "Payment frequency" }).selectOption({ label: "Half-yearly — 2 payments/yr" });
  await expect(dlg.getByText(/Taxable ₹1,57,500 · GST 18% ₹28,350 · Total ₹1,85,850 · Due now ₹92,925/)).toBeVisible();
  const tdsBtn = dlg.getByRole("button", { name: `TDS deducted (₹${tds})` });
  await expect(tdsBtn).toBeVisible();
  if ((await tdsBtn.getAttribute("aria-pressed")) !== "true") await tdsBtn.click();
  await dlg.getByRole("combobox", { name: "TDS section" }).selectOption({ label: "194C — contract work" });
  await dlg.getByRole("button", { name: /^Record sale & reconcile/ }).click();
  const done = dlg.getByRole("region", { name: "Done — this bank line is reconciled" });
  await expect(done).toBeVisible({ timeout: 120_000 });
  return (await done.innerText()).replace(/\s+/g, " ").trim();
}

/** The TDS Receivable row for `name` → its cells by column head (lower case: gross, tds, rate …). */
async function tdsRow(page: Page, name: string): Promise<Record<string, string>> {
  await openAppPage(page, "/accounting/tds-receivable");
  const row = page.locator("main table tbody tr").filter({ hasText: name });
  await expect(row, `one TDS row for ${name}`).toHaveCount(1, { timeout: 60_000 });
  const table = row.locator("xpath=ancestor::table[1]");
  // textContent, not innerText: the heads are upper-cased by CSS.
  const head = (await table.getByRole("columnheader").allTextContents()).map((h) => h.trim().toLowerCase());
  const cells = (await row.getByRole("cell").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
}

test.describe("R-2538 — TDS gross on a sale billed in parts = the part paid", () => {
  onlyInCardTests();
  // A sale through the reconcile sheet can take 2+ min on a busy local dev server (7 Nov: one run hit 180 s).
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });

  test("Step 1: Banking → ₹91,350 money-in line → New sale: half-yearly, 50 × ₹3,150 M365 Basic, 1-year, TDS ₹1,575 at 2% (194C) → booked", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const done = await bookNewSale(page, "part", "1,575");
      expect(done).toMatch(/₹1,575 TDS booked as TDS receivable/);
      test.info().annotations.push({ type: "note", description: done.slice(0, 400) });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Accounting → TDS Receivable — the new row's gross is ₹78,750 (half-year taxable), not ₹1,57,500; rate 2%", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const r = await tdsRow(page, NAME.part);
      expect(r.gross, `Gross — row ${JSON.stringify(r)}`).toBe("₹78,750");
      expect(r.tds, "TDS").toBe("₹1,575");
      expect(r.rate, "Rate").toMatch(/^2(\.00)?%$/);
      test.info().annotations.push({ type: "note", description: `TDS Receivable: ${JSON.stringify(r)}` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Same with TDS ₹3,150 at 2% (customer deducted on the whole year) → gross ₹1,57,500", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const done = await bookNewSale(page, "full", "3,150");
      expect(done).toMatch(/₹3,150 TDS booked as TDS receivable/);
      const r = await tdsRow(page, NAME.full);
      expect(r.gross, `Gross — row ${JSON.stringify(r)}`).toBe("₹1,57,500");
      expect(r.tds, "TDS").toBe("₹3,150");
      expect(r.rate, "Rate").toMatch(/^2(\.00)?%$/);
      test.info().annotations.push({ type: "note", description: `TDS Receivable: ${JSON.stringify(r)}` });
    } finally {
      await page.context().close();
    }
  });
});
