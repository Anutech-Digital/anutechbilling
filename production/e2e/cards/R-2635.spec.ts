/**
 * Card test — R-2635 (split of R-2171 item 3): "Generate GST Invoice" for a customer abroad said
 * "goes out as a B2C invoice" and "Dated <today> (today)". Now the confirm says Export, 0% GST under
 * the LUT of the invoice date's FY, and the date generate_invoice really uses (the receipt day, R-2095).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2635`.
 *
 * Data: planted by this spec on the LOCAL docker DB — customer "SCN Export Peak" (United States,
 * Overseas) with accepted one-time USD quote Q-SCN-EXP-1 ($139 @ ₹95 = ₹13,206, 0% GST) and one
 * received payment on 26 Aug 2026 (IST), no invoice. Fixed ids, re-planted on each run and left for a
 * person to look at. The LUT rows for FY 2026-27 come from scenario lut-per-fy (already on E2E Test Co).
 * The test never presses "Issue invoice" — Cancel only, so no invoice number is used.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2635000-0000-4000-8000-000000000001";
const PAYMENT_ID = "c2635000-0000-4000-8000-000000000011";
const CUSTOMER = "SCN Export Peak";
const QUOTE = "Q-SCN-EXP-1";

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
begin;
delete from public.payments where id = '${PAYMENT_ID}';
delete from public.quotes where id = '${QUOTE}' and invoice_id is null;
delete from public.customers where id = '${CUSTOMER_ID}' and not exists (select 1 from public.quotes q where q.customer_id = '${CUSTOMER_ID}');
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'United States', 'overseas', 'business', 'R-2635 card test: export customer'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                           discount_pct, status, payment_status, created_date, expires_date, billing_cycle, currency, exchange_rate,
                           line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Export coaching', 1, 13206, 13206, 6000, 0, 0, 'accepted', 'awaiting',
       '2026-08-20', '2026-09-04', 'yearly', 'USD', 95,
       '[{"id": "line-1", "qty": 1, "cost": 6000, "name": "SCN Export coaching (one time)", "rate": 13206, "one_time": true}]'::jsonb,
       true, 'R-2635 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at)
select '${PAYMENT_ID}', t.id, '${QUOTE}', '${CUSTOMER_ID}', 13206, 'bank_transfer', 'received', '2026-08-26 11:00:00+05:30'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
   and exists (select 1 from public.quotes q where q.id = '${QUOTE}' and q.invoice_id is null);
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2635 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2635 — issue confirm for a customer abroad: export 0% under LUT, real date", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: Generate GST Invoice → the confirm says Export 0% under the FY's LUT, never B2C", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${QUOTE}`);
    await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Issued as an export invoice to ${CUSTOMER} (United States): 0% GST under LUT`, { timeout: 60_000 });
    await expect(dialog).toContainText("(FY 2026-27)");
    await expect(dialog).toContainText("SUPPLY MEANT FOR EXPORT");
    await expect(dialog).not.toContainText("B2C");
  });

  test("Step 2: the confirm names the receipt day, not today; Cancel issues nothing", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${QUOTE}`);
    await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/Dated 26 Aug 2026 — the day the money came in/, { timeout: 60_000 });
    await expect(dialog).not.toContainText("(today)");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first()).toBeVisible();
  });
});
