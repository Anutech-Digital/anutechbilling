/**
 * Card test — R-2647: the /invoices list "Generate" confirm says the same as the quote page's (R-2635/R-2636):
 * a customer abroad is an export (0% under the FY's LUT, or WITH payment of IGST when the quote charges
 * GST), never "B2C", and the date is the day the money came in.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2647`.
 *
 * Data: planted by this spec on the LOCAL docker DB — customer "SCN Export Lima" (Peru, Overseas) with two
 * paid, un-invoiced quotes: Q-SCN-2647-0 (₹13,206 at 0% GST) and Q-SCN-2647-18 (₹11,800 = ₹10,000 + 18%),
 * each with a receipt on 26 Aug 2026. The LUT rows for FY 2026-27 come from scenario lut-per-fy (already
 * on E2E Test Co). The test never presses "Issue invoice" — Cancel only, so no invoice number is used.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2647000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Export Lima";
const Q0 = "Q-SCN-2647-0";
const Q18 = "Q-SCN-2647-18";
const PAY0 = "c2647000-0000-4000-8000-000000000010";
const PAY18 = "c2647000-0000-4000-8000-000000000018";

function quoteSql(id: string, pay: string, amount: number, subtotal: number, rate: number): string {
  return `
delete from public.payments where id = '${pay}' and exists (select 1 from public.quotes q where q.id = '${id}' and q.invoice_id is null);
delete from public.quotes where id = '${id}' and invoice_id is null;
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                           discount_pct, status, payment_status, payment_amount, payment_received_at, created_date, expires_date, billing_cycle,
                           line_items, is_one_off, notes)
select '${id}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Export setup', 1, ${amount}, ${subtotal}, 4000, ${rate}, 0, 'accepted', 'received', ${amount}, '2026-08-26 11:00:00+05:30',
       '2026-08-20', '2026-09-04', 'yearly',
       '[{"id": "line-1", "qty": 1, "cost": 4000, "name": "SCN Export setup (one time)", "rate": ${subtotal}, "one_time": true}]'::jsonb,
       true, 'R-2647 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at)
select '${pay}', t.id, '${id}', '${CUSTOMER_ID}', ${amount}, 'bank_transfer', 'received', '2026-08-26 11:00:00+05:30'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
   and exists (select 1 from public.quotes q where q.id = '${id}' and q.invoice_id is null)
on conflict (id) do nothing;`;
}

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
begin;
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'Peru', 'overseas', 'business', 'R-2647 card test: export customer'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
${quoteSql(Q0, PAY0, 13206, 13206, 0)}
${quoteSql(Q18, PAY18, 11800, 10000, 18)}
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2647 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** Opens /invoices and presses "Generate" on the pending row of `quote`. */
async function openConfirm(page: Page, quote: string) {
  await openAppPage(page, "/invoices");
  /* The "Pending GST invoice generation" list opens with its header (Expand). */
  await page.locator("main").getByText("Pending GST invoice generation").first().click({ timeout: 30_000 });
  /* The phone cards and the desktop table are both in the page — press the visible row's button. */
  const quoteLink = page.locator("main").getByRole("link", { name: quote, exact: true }).locator("visible=true").first();
  await expect(quoteLink).toBeVisible({ timeout: 30_000 });
  const row = page.locator("main tr").filter({ has: page.getByRole("link", { name: quote, exact: true }) }).locator("visible=true").first();
  await row.getByRole("button", { name: "Generate", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test.describe("R-2647 — /invoices Generate confirm: same export / LUT / IGST words and real date as the quote page", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: 0% export quote → export under the FY's LUT, dated the receipt day, never B2C", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dialog = await openConfirm(page, Q0);
    await expect(dialog).toContainText(`Issued as an export invoice to ${CUSTOMER} (Peru): 0% GST under LUT`, { timeout: 60_000 });
    await expect(dialog).toContainText("(FY 2026-27)");
    await expect(dialog).toContainText(/Dated 26 Aug 2026 — the day the money came in/);
    await expect(dialog).not.toContainText("B2C");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Step 2: export quote that charges 18% → WITH payment of IGST, never B2C", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dialog = await openConfirm(page, Q18);
    await expect(dialog).toContainText("WITH payment of IGST (₹1,800 IGST, GSTR-1 table 6A WPAY), never CGST+SGST", { timeout: 60_000 });
    await expect(dialog).not.toContainText("B2C");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
