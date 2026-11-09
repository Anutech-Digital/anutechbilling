/**
 * Card test — R-2631 "New invoices on non-bank paths must know about GST-filed months" (owner's option A:
 * the money is always recorded; a NEW tax invoice is dated on the first open day, never in a filed month).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2631`.
 *
 * Data (planted here, local docker DB only): SCN First Open Buyer (Delhi), accepted quote Q-SCN-GFO-1 ₹5,900
 * (₹5,000 + 18%), no invoice, with a ₹5,900 receipt received 18 Sep 2026. E2E Test Co's "GST returns filed up
 * to" is cleared before step 1 (the owner sets it in step 1) and put back to what it was after the last step; the
 * planted rows are removed after the last step.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUSTOMER_ID = "c2631000-0000-4000-8000-000000000001";
const PAYMENT_ID = "c2631000-0000-4000-8000-000000000011";
const CUSTOMER = "SCN First Open Buyer";
const QUOTE = "Q-SCN-GFO-1";

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
  if (why || !c) throw new Error(`R-2631 card test refuses to write test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const T = `(select t.id from public.tenants t where t.email = '${E2E_TENANT_EMAIL}')`;

/** Removes this test's rows (an invoice it raised goes too — it is a local test invoice). Step 3's invoice is
    PAID (the planted receipt settles it), so tg_invoices_block_delete_issued refuses a plain delete; the trigger's
    own named way past it (app.invoice_amend_reason, transaction-local) is used — local docker DB only (psql()). */
function unplant(): void {
  psql(`
begin;
set local app.invoice_amend_reason = 'R-2631 card test cleanup (local test invoice)';
update public.quotes set invoice_id = null, payment_status = 'awaiting' where id = '${QUOTE}';
delete from public.invoices where quote_id = '${QUOTE}' and tenant_id = ${T};
delete from public.payments where id = '${PAYMENT_ID}';
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUSTOMER_ID}';
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', '07AAHCF2631K1Z5', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'business',
       'R-2631 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct, status,
                           payment_status, created_date, billing_cycle, currency, line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Workspace setup', 1, 5900, 5000, 18, 0, 'accepted', 'awaiting',
       '2026-09-05', 'yearly', 'INR',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace setup (one time)", "rate": 5000, "one_time": true}]'::jsonb,
       true, 'R-2631 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at)
select '${PAYMENT_ID}', t.id, '${QUOTE}', '${CUSTOMER_ID}', 5900, 'bank_transfer', 'R2631-CARD-SEP', 'received', '2026-09-18 11:00:00+05:30'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;`);
}

/** The owner's setting before this test, put back after it (postgres session — the guard trigger refuses only
    request logins). */
let savedSetting: string | null = null;
function readSetting(): string | null {
  const v = (psql(`select coalesce(gst_filed_through::text, '') from public.tenants where email = '${E2E_TENANT_EMAIL}';`)[0] ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function writeSetting(v: string | null): void {
  psql(`update public.tenants set gst_filed_through = ${v ? `'${v}'` : "null"} where email = '${E2E_TENANT_EMAIL}';`);
}

function invoiceOfQuote(): string {
  return (psql(`select coalesce(string_agg(i.invoice_date::text, ','), '') from public.invoices i where i.quote_id = '${QUOTE}';`)[0] ?? "").trim();
}

function receiptDay(): string {
  return (psql(`select ((received_at at time zone 'Asia/Kolkata')::date)::text from public.payments where id = '${PAYMENT_ID}';`)[0] ?? "").trim();
}

test.describe("R-2631 — a new invoice for money of a GST-filed month is dated on the first open day", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    savedSetting = readSetting();
    writeSetting(null);
    plant();
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON) return;
    writeSetting(savedSetting);
    unplant();
  });

  test("Step 1: Accounting → Overview → GST returns filed up to → September 2026 → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting");
      const card = page.getByTestId("gst-filed-through-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("Not set", { timeout: 60_000 });
      await card.getByLabel("GST returns filed up to (month)").fill("2026-09");
      await expect(card.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 30_000 });
      await card.getByRole("button", { name: "Save" }).click();
      await page.getByRole("button", { name: "Save" }).last().click(); // the confirm dialog
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("GST returns are filed up to September 2026", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Quote Q-SCN-GFO-1 (paid 18 Sep) → Generate GST Invoice → the confirm says Dated 1 Oct 2026 — the first open day", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/Dated 1 Oct 2026 — the first open day/, { timeout: 60_000 });
      await expect(dialog).not.toContainText("18 Sep 2026");
      await expect(dialog).not.toContainText("(today)");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: issue it → one invoice dated 1 Oct 2026 (not in September); the receipt stays on 18 Sep", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/Dated 1 Oct 2026/, { timeout: 60_000 });
      await dialog.getByRole("button", { name: "Issue invoice" }).click();
      await expect.poll(() => invoiceOfQuote(), { timeout: 120_000, message: "one invoice on the quote, dated 1 Oct 2026" }).toBe("2026-10-01");
      expect(receiptDay()).toBe("2026-09-18");
    } finally {
      await page.context().close();
    }
  });
});
