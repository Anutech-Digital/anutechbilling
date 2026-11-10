/**
 * Card test — R-2651: the /invoices bulk "Generate N" confirm lists, per selected quote, the same date and
 * export / LUT / IGST line its single "Generate" confirm shows (R-2647), and names no INV number range
 * when an invoice date falls in another FY (each date's own series).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2651`.
 *
 * Data: planted by this spec on the LOCAL docker DB — customer "SCN Export Quito" (Ecuador, Overseas) with two
 * paid, un-invoiced quotes: Q-SCN-2651-A (₹13,206 at 0% GST, paid 27 Aug 2026) and Q-SCN-2651-B (₹11,800 =
 * ₹10,000 + 18%, paid 20 Mar 2026 — FY 2025-26). The LUTs for FY 2025-26 and 2026-27 come from scenario
 * lut-per-fy (already on E2E Test Co). The test never presses "Issue" — Cancel only, so no number is used.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2651000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Export Quito";
const QA = "Q-SCN-2651-A";
const QB = "Q-SCN-2651-B";

function quoteSql(id: string, pay: string, amount: number, subtotal: number, rate: number, paidAt: string, created: string, expires: string): string {
  return `
delete from public.payments where id = '${pay}' and exists (select 1 from public.quotes q where q.id = '${id}' and q.invoice_id is null);
delete from public.quotes where id = '${id}' and invoice_id is null;
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                           discount_pct, status, payment_status, payment_amount, payment_received_at, created_date, expires_date, billing_cycle,
                           line_items, is_one_off, notes)
select '${id}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Export setup', 1, ${amount}, ${subtotal}, 4000, ${rate}, 0, 'accepted', 'received', ${amount}, '${paidAt}',
       '${created}', '${expires}', 'yearly',
       '[{"id": "line-1", "qty": 1, "cost": 4000, "name": "SCN Export setup (one time)", "rate": ${subtotal}, "one_time": true}]'::jsonb,
       true, 'R-2651 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at)
select '${pay}', t.id, '${id}', '${CUSTOMER_ID}', ${amount}, 'bank_transfer', 'received', '${paidAt}'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
   and exists (select 1 from public.quotes q where q.id = '${id}' and q.invoice_id is null)
on conflict (id) do nothing;`;
}

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\set ON_ERROR_STOP 1
begin;
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'Ecuador', 'overseas', 'business', 'R-2651 card test: export customer'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
${quoteSql(QA, "c2651000-0000-4000-8000-00000000000a", 13206, 13206, 0, "2026-08-27 11:00:00+05:30", "2026-08-20", "2026-09-04")}
${quoteSql(QB, "c2651000-0000-4000-8000-00000000000b", 11800, 10000, 18, "2026-03-20 11:00:00+05:30", "2026-03-15", "2026-03-30")}
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2651 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** Opens /invoices, ticks QA and QB in the pending list and presses "Generate 2". */
async function openBulkConfirm(page: Page) {
  await openAppPage(page, "/invoices");
  await page.locator("main").getByText("Pending GST invoice generation").first().click({ timeout: 30_000 });
  for (const q of [QA, QB]) {
    const box = page.locator("main").getByRole("checkbox", { name: `Select ${q}`, exact: true }).locator("visible=true").first();
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.check();
  }
  await page.locator("main").getByRole("button", { name: "Generate 2", exact: true }).locator("visible=true").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test.describe("R-2651 — /invoices bulk 'Generate N' confirm: per-quote date + export / LUT / IGST", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: each quote shows its own date and its export line (0% under LUT / WITH payment of IGST), never B2C", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dialog = await openBulkConfirm(page);
    await expect(dialog).toContainText(`${QA} · ${CUSTOMER}: Dated 27 Aug 2026 — the day the money came in`, { timeout: 60_000 });
    await expect(dialog).toContainText(`export invoice to ${CUSTOMER} (Ecuador): 0% GST under LUT AD2704260024582 (FY 2026-27)`);
    await expect(dialog).toContainText(`${QB} · ${CUSTOMER}: Dated 20 Mar 2026`);
    await expect(dialog).toContainText("WITH payment of IGST (₹1,800 IGST, GSTR-1 table 6A WPAY)");
    await expect(dialog).not.toContainText("B2C");
    await expect(dialog.getByRole("button", { name: "Issue 2 invoices" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Step 2: a date in FY 2025-26 → no single INV number range is promised", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dialog = await openBulkConfirm(page);
    await expect(dialog).toContainText("each invoice date's financial year (FY 2025-26, FY 2026-27)", { timeout: 60_000 });
    await expect(dialog).not.toContainText(/INV-[A-Z0-9]+-\d+-\d+ … /);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Step 3: an export with no LUT for its date's FY holds the whole bulk issue (Untick Q-…)", async () => {
    test.skip(true, "Needs a FY with no LUT on E2E Test Co (both FY 2025-26 and 2026-27 have one) — proven by unit tests in src/lib/invoices/pending-issuable.test.ts (R-2651).");
  });
});
