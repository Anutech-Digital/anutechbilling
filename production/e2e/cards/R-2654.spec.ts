/**
 * Card test — R-2654 "Razorpay settlements: month batch 'Reconcile all ready'" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2654` (after `npm run localhost:update` brings the R-2654 code
 * and migration to localhost).
 *
 * Data (E2E Test Co + the local docker DB only; taken out again in afterAll): one open money-in line
 * "NEFT CR-…-RAZORPAY PAYMENTS PVT LTD … CT2654" of ₹1,156 on 3 Oct 2025 in the E2E bank account.
 * The local company has no Razorpay key, so the sheet must ask for it and NOTHING calls Razorpay —
 * when a key IS stored locally the steps that would read Razorpay are skipped (never a real call).
 * Pairing, Ready/Blocked, "Reconcile all ready" and "Undo this run" are proven with Razorpay mocked
 * (src/lib/razorpay/settlement-batch*.test.ts) and on the local DB (supabase/tests/r2654_*.test.sql);
 * on staging they need Razorpay TEST keys.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_BANK_NAME } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const TXN = "c2654000-0000-4000-8000-000000000001";
const NARR = "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-CT2654";

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
  if (why || !c) throw new Error(`R-2654 card test refuses to write test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/** E2E Test Co, its E2E bank account, and whether a Razorpay key is stored (then Razorpay steps skip). */
function facts(): { tenant: string; account: string; hasKey: boolean } {
  const rows = psql(`select t.id || '|' || coalesce((select ba.id::text from public.bank_accounts ba where ba.tenant_id = t.id and ba.name = '${E2E_BANK_NAME}' order by ba.created_at limit 1), '')
                         || '|' || exists(select 1 from public.tenant_secrets s where s.tenant_id = t.id and s.razorpay_key_id is not null)
                       from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';`);
  if (rows.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${rows.length}`);
  const [tenant, account, key] = rows[0].split("|");
  if (!account) throw new Error(`E2E Test Co has no bank account "${E2E_BANK_NAME}"`);
  return { tenant, account, hasKey: key === "t" };
}

function clear(): void {
  psql(`delete from public.bank_transactions where id = '${TXN}' and matched_to_type is null;`);
}

function seed(): void {
  const { tenant, account } = facts();
  clear();
  psql(`insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
        values ('${TXN}', '${tenant}', '${account}', '2025-10-03', '${NARR}', 0, 1156, 'CT2654UTR', 'manual');`);
}

test.describe.serial("R-2654 — Razorpay settlements: a month at once", () => {
  onlyInCardTests();
  test.beforeAll(() => { if (CARD_TESTS_ON) seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clear(); });

  test("Step 1: Owner → Banking → E2E bank → 'Razorpay settlements (N)' → Oct 2025 → asks for the Razorpay key", async ({ browser, baseURL }) => {
    const { account, hasKey } = facts();
    test.skip(hasKey, "A Razorpay key is stored locally — the sheet would call Razorpay; never in a test.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/accounting/banking/${account}`);
    const btn = page.getByRole("button", { name: /Razorpay settlements \(\d+\)/ });
    await expect(btn).toBeVisible({ timeout: 30_000 });
    await btn.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/Razorpay settlements —/)).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: "Month" })).toContainText(/2025/);
    await expect(sheet.getByText(/Add your Razorpay API key in Settings → Integrations/)).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("link", { name: /Open Settings → Integrations/ })).toHaveAttribute("href", "/settings?tab=integrations");
    await expect(sheet.getByRole("button", { name: /Reconcile all ready \(0\)/ })).toBeDisabled();
  });

  test("Step 2: Billing login — no 'Razorpay settlements' button (owner / accountant only)", async ({ browser, baseURL }) => {
    const { account } = facts();
    const page = await pageAs(browser, baseURL, "billing");
    await openAppPage(page, `/accounting/banking/${account}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Razorpay settlements/ })).toHaveCount(0);
  });

  test("Step 3: with a Razorpay TEST key — Ready / Blocked table, Reconcile all ready, Undo this run", async () => {
    test.skip(true, "Needs a Razorpay key and real settlements (staging, TEST keys) — proven here with Razorpay mocked: settlement-batch.server.test.ts + r2654 SQL test.");
  });
});
