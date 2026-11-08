/**
 * Card test — R-2602 "Amazon Business purchases: import 'Reconciliation by shipment level' CSV →
 * draft expenses per order + one expected bank debit per Payment Reference".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2602`.
 *
 * Data: the made-up sample file docs/samples/amazon-business-import-sample.csv (T- names, invented
 * order ids 260-2602…). The orders it creates are removed again after the run (local docker DB only).
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
const SAMPLE = path.join(PROD, "docs", "samples", "amazon-business-import-sample.csv");
const VENDOR = "Amazon seller (unknown)";
/** The sample's order ids (the cancelled 260-2602003 never becomes a row). */
const ORDERS = ["260-2602001-0000001", "260-2602002-0000002", "T60-2602004-0000004"];

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
  if (why || !c) throw new Error(`R-2602 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function e2eTenant(c: string): string {
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  return tenants[0].trim();
}

const IN = ORDERS.map((o) => `'${o}'`).join(", ");
function clean(): void {
  const c = container();
  psql(c, `delete from public.expenses where tenant_id = '${e2eTenant(c)}' and vendor_name = '${VENDOR}' and bill_no in (${IN});`);
}

function rows(): string[] {
  const c = container();
  return psql(c, `select bill_no || '|' || amount || '|' || paid || '|' || bill_type || '|' || gst_paid || '|' || category
    from public.expenses where tenant_id = '${e2eTenant(c)}' and vendor_name = '${VENDOR}' and bill_no in (${IN}) order by bill_no;`);
}

test.describe("R-2602 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    clean();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: Expenses → Import Amazon report → choose the sample CSV → preview: 3 orders to import, 1 cancelled left out, 2 expected bank debits", async () => {
    await openAppPage(page, "/accounting/expenses", /Expenses/);
    await page.getByRole("button", { name: "Import Amazon report" }).click();
    const dlg = page.getByRole("dialog", { name: "Import Amazon Business report" });
    await expect(dlg).toBeVisible();
    await dlg.locator("#amazon-import-csv").setInputFiles(SAMPLE);
    const summary = dlg.getByTestId("amazon-import-summary");
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText("3 orders to import as drafts");
    await expect(summary).toContainText("₹5,511"); // 1,652 + 2,360 + 1,499
    await expect(dlg.getByText("1 cancelled left out")).toBeVisible();
    const debits = dlg.getByTestId("amazon-expected-debits");
    await expect(debits).toContainText("₹4,012"); // ref A: 1,652 + 2,360
    await expect(debits).toContainText("₹1,499"); // ref B: Prime
    await expect(dlg.getByText("Prime membership — booked as a subscription expense (Software).")).toBeVisible();
    await expect(dlg.getByText(/not claimed/).first()).toBeVisible();
  });

  test("Step 2: Import 3 orders as drafts → success; the books hold 3 unpaid rows, GST credit off (bill_type none, gst_paid 0)", async () => {
    const dlg = page.getByRole("dialog", { name: "Import Amazon Business report" });
    await dlg.getByRole("button", { name: "Import 3 orders as drafts" }).click();
    await expect(dlg.getByText(/3 orders imported as drafts/)).toBeVisible({ timeout: 60_000 });
    await expect.poll(rows, { timeout: 30_000 }).toEqual([
      "260-2602001-0000001|1652|false|none|0|Equipment",
      "260-2602002-0000002|2360|false|none|0|Equipment",
      "T60-2602004-0000004|1499|false|none|0|Software",
    ]);
    await dlg.getByRole("button", { name: "Done" }).click();
  });

  test("Step 3: Expenses list (Aug 2026, unpaid) shows the three 'Amazon seller (unknown)' drafts; uploading the same file again finds them 'already'", async () => {
    await openAppPage(page, "/accounting/expenses?from=2026-08-01&to=2026-08-31&q=Amazon", /Expenses/);
    await expect(page.getByRole("cell", { name: VENDOR }).first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Import Amazon report" }).click();
    const dlg = page.getByRole("dialog", { name: "Import Amazon Business report" });
    await dlg.locator("#amazon-import-csv").setInputFiles(SAMPLE);
    const summary = dlg.getByTestId("amazon-import-summary");
    await expect(summary).toContainText("0 orders to import", { timeout: 60_000 });
    await expect(dlg.getByText("3 already in Expenses")).toBeVisible();
    await expect(dlg.getByRole("button", { name: /^Import \d+ order/ })).toHaveCount(0);
  });
});
