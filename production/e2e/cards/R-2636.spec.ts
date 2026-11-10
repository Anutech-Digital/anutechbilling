/**
 * Card test — R-2636: quote → invoice for a customer abroad whose quote still charges GST. Before, the
 * invoice came out as an "export" with CGST+SGST; now it is an export WITH payment of IGST (GSTR-1 6A
 * WPAY), the amount kept. The issue confirm says so before the click.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2636`.
 *
 * Data: planted by this spec on the LOCAL docker DB — customer "SCN Export Oslo" (Norway, Overseas) with
 * accepted quote Q-SCN-EXP-18 (₹10,000 + 18% GST = ₹11,800, made before the country was set), no
 * invoice. Fixed ids, re-planted while not invoiced. The test never presses "Issue invoice" (Cancel only).
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2636000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Export Oslo";
const QUOTE = "Q-SCN-EXP-18";

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\set ON_ERROR_STOP 1
begin;
delete from public.quotes where id = '${QUOTE}' and invoice_id is null;
delete from public.customers where id = '${CUSTOMER_ID}' and not exists (select 1 from public.quotes q where q.customer_id = '${CUSTOMER_ID}');
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'Norway', 'overseas', 'business', 'R-2636 card test: export customer, old 18% quote'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                           discount_pct, status, payment_status, created_date, expires_date, billing_cycle,
                           line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Export setup', 1, 11800, 10000, 4000, 18, 0, 'accepted', 'awaiting',
       '2026-11-01', '2026-11-16', 'yearly',
       '[{"id": "line-1", "qty": 1, "cost": 4000, "name": "SCN Export setup (one time)", "rate": 10000, "one_time": true}]'::jsonb,
       true, 'R-2636 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2636 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2636 — export quote that charges GST: IGST (with payment), never CGST+SGST", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: Generate GST Invoice → the confirm says export WITH payment of IGST, never CGST+SGST", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${QUOTE}`);
    await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("WITH payment of IGST (₹1,800 IGST, GSTR-1 table 6A WPAY), never CGST+SGST", { timeout: 60_000 });
    await expect(dialog).not.toContainText("B2C");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Step 2: Issue → the invoice shows IGST ₹1,800, no CGST/SGST", async () => {
    test.skip(true, "Issuing uses a real invoice number on the local company — the person presses Issue once; the server rule is proved by supabase/tests/r2636_export_tax_head.test.sql (A, F)");
  });
});
