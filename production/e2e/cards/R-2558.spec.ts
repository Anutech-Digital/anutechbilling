/**
 * Card test — R-2558 "Bank 'New sale' form: a TDS rate box; gross = TDS × 100 ÷ rate" (R-2572).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2558`.
 *
 * Data (made fresh on every run and removed after the last step — E2E Test Co + the local docker DB
 * only), written with the scenario helpers (scripts/dev/scenarios/_common.sql → pg_temp.scn_clear
 * removes what a run made from them: quotes, invoices, payments, TDS rows, subscriptions, bank matches):
 *   · CT R2558 Rate Box Pvt Ltd with a ₹89,775 money-in line on "SCN HDFC Current ··7788" =
 *     part 1 of a half-yearly sale (₹92,925) less ₹3,150 TDS — 2% of the WHOLE year's ₹1,57,500.
 * The sale is booked through the real Banking → Reconcile → "A new sale (no quote yet)" form:
 * E2E Microsoft 365 Business Basic, 50 seats × ₹3,150/user/year, Annual commitment, Half-yearly.
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
const CUST = "c2558000-0000-4000-8000-000000000001";
const TXN = "c2558000-0000-4000-8000-000000000011";
const NAME = "CT R2558 Rate Box Pvt Ltd";
const LINE = "CT R2558 RATE BOX PVT LTD";

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
  if (why || !c) throw new Error(`R-2558 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/** Opens a transaction and removes what an earlier run made from the card's customer and line — nothing else. */
function clearSql(c: string): string[] {
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenants[0].trim()}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], array['${TXN}']::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], array['${CUST}']);`,
  ];
}

function seed(): void {
  const c = container();
  psql(c, [
    ...clearSql(c),
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
      ('${CUST}', :'tenant', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2558.example', 'Card test R-2558 — local only');`,
    `insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
      ('${TXN}', :'tenant', :'acct', current_date - 1, 'NEFT CR-HDFC0002558-${LINE}-M365 H1', 0, 89775, 'CT-N2025582558011', 'csv_upload');`,
    "commit;",
  ].join("\n"));
}

/*
 * One run = one data set: a failed step starts a NEW worker (beforeAll/afterAll run again), so seed
 * once per run (marker named after the runner) and clean up only after the LAST step has run.
 */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2558-${process.ppid}.seeded`);
const LAST_STEP = "Step 2";

test.describe("R-2558 — bank New sale: TDS rate box, gross from the rate", () => {
  onlyInCardTests();
  // A sale through the reconcile sheet can take 2-3 min on a busy local dev server (7 Nov: the save alone >120 s).
  test.setTimeout(480_000);

  const stepsRun: string[] = [];
  test.beforeAll(() => {
    if (!CARD_TESTS_ON || fs.existsSync(RUN_MARKER)) return;
    seed();
    fs.writeFileSync(RUN_MARKER, new Date().toISOString());
  });
  test.afterEach(() => {
    stepsRun.push(test.info().title);
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON || !stepsRun.some((t) => t.startsWith(LAST_STEP))) return;
    const c = container();
    psql(c, [...clearSql(c), "commit;"].join("\n"));   // leave no test data behind
    fs.rmSync(RUN_MARKER, { force: true });
  });

  test("Step 1: Banking → ₹89,775 line → New sale 50 × ₹3,150 half-yearly → TDS rate % box shows 2, section 194C, 'gross ₹1,57,500 @ 2%' for TDS ₹3,150 → booked", async ({ browser, baseURL }) => {
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
      await dlg.getByRole("combobox", { name: "Add a product" }).selectOption({ label: "E2E Microsoft 365 Business Basic · microsoft" });
      await dlg.getByRole("combobox", { name: "Commitment" }).selectOption({ label: "Annual commitment" });
      await dlg.getByLabel(/^Seats/).fill("50");
      await dlg.getByLabel(/^Unit price/).fill("3150");
      await dlg.getByRole("combobox", { name: "Payment frequency" }).selectOption({ label: "Half-yearly — 2 payments/yr" });
      await expect(dlg.getByText(/Taxable ₹1,57,500 · GST 18% ₹28,350 · Total ₹1,85,850 · Due now ₹92,925/)).toBeVisible();
      const tdsBtn = dlg.getByRole("button", { name: "TDS deducted (₹3,150)" });
      await expect(tdsBtn).toBeVisible();
      if ((await tdsBtn.getAttribute("aria-pressed")) !== "true") await tdsBtn.click();

      const rate = dlg.getByLabel("TDS rate %");
      // 2% of the whole year — the old form derived TDS ÷ part = 4%.
      await expect(rate, "TDS rate % box pre-filled with 2").toHaveValue(/^2(\.0+)?$/, { timeout: 30_000 });
      await dlg.getByRole("combobox", { name: "TDS section" }).selectOption({ label: "194C — contract work" });
      const line = dlg.getByText(/^Booked as TDS receivable — /);
      await expect(line).toContainText(/194C, gross ₹1,57,500 @ 2(\.0+)?%/);
      const lineText = (await line.innerText()).replace(/\s+/g, " ").trim();

      await dlg.getByRole("button", { name: /^Record sale & reconcile/ }).click();
      const done = dlg.getByRole("region", { name: "Done — this bank line is reconciled" });
      await expect(done).toBeVisible({ timeout: 240_000 });
      await expect(done).toContainText(/₹3,150 TDS booked as TDS receivable/);
      test.info().annotations.push({ type: "note", description: lineText.slice(0, 400) });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Accounting → TDS Receivable — the row: gross ₹1,57,500, TDS ₹3,150, rate 2%, Invoice column shows its INV-… number (not —)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/tds-receivable");
      const row = page.locator("main table tbody tr").filter({ hasText: NAME });
      await expect(row, `one TDS row for ${NAME}`).toHaveCount(1, { timeout: 60_000 });
      const table = row.locator("xpath=ancestor::table[1]");
      // textContent, not innerText: the heads are upper-cased by CSS.
      const head = (await table.getByRole("columnheader").allTextContents()).map((h) => h.trim().toLowerCase());
      const cells = (await row.getByRole("cell").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      const r = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
      expect(r.gross, `Gross — row ${JSON.stringify(r)}`).toBe("₹1,57,500");
      expect(r.tds, "TDS").toBe("₹3,150");
      expect(r.rate, "Rate").toMatch(/^2(\.00)?%$/);
      expect(r.invoice, `Invoice column — row ${JSON.stringify(r)}`).toMatch(/^INV-\S+/);
      test.info().annotations.push({ type: "note", description: `TDS Receivable: ${JSON.stringify(r)}` });
    } finally {
      await page.context().close();
    }
  });
});
