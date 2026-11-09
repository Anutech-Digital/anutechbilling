/**
 * Card test — R-2623: a COGS bill's service period (the month the licence was used) is shown on the
 * bill and the owner can change it. A Google bill dated 7 Oct 2026 with no month on it is for
 * September (auto — the month before); the owner sets August; "Use auto" brings September back.
 * The database side (books lock lets only the period through on a filed month, GST unchanged) is
 * supabase/tests/r2623_bill_service_period_edit.test.sql.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2623`.
 *
 * Data: planted by this spec on the LOCAL docker DB — bill SCN-GOOG-2623 (Google, COGS-Workspace,
 * 7 Oct 2026, ₹10,000, no month written on it, period empty). Fixed id, re-planted on each run.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const BILL_ID = "BILL-SCN-2623";
const BILL_NO = "SCN-GOOG-2623";

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
begin;
delete from public.vendor_bills where id = '${BILL_ID}';
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total,
                                 status, paid_amount, currency, fx_rate, document_type, line_items)
select '${BILL_ID}', t.id, 'Google Cloud India (SCN)', '${BILL_NO}', '2026-10-07', 'COGS-Workspace', 10000, 0, 0, 1800, 11800,
       'unpaid', 0, 'INR', 1, 'tax_invoice', '[]'::jsonb
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2623 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

async function openBill(page: Page) {
  await openAppPage(page, `/accounting/bills?from=2026-10-01&to=2026-10-31&q=${BILL_NO}`);
  const row = page.getByRole("row").filter({ hasText: BILL_NO }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  return row;
}

test.describe("R-2623 — service period on a COGS bill", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: the 7 Oct Google bill says 'for Sep 2026' in the list and 'Sep 2026 · auto' on the bill", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await openBill(page);
    await expect(row).toContainText("for Sep 2026");
    await row.click();
    await expect(page.getByTestId(`bill-${BILL_ID}-service-period`))
      .toHaveText("Sep 2026 · auto (Google / Microsoft bill: month before the bill date)", { timeout: 30_000 });
  });

  test("Step 2: Change → August → Save period → 'Aug 2026 · set on the bill', list 'for Aug 2026'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await openBill(page);
    await row.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Change" }).click();
    await dlg.getByLabel("First month").fill("2026-08");
    await dlg.getByLabel("Last month").fill("2026-08");
    await dlg.getByRole("button", { name: "Save period" }).click();
    await expect(page.getByTestId(`bill-${BILL_ID}-service-period`)).toHaveText("Aug 2026 · set on the bill", { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(row).toContainText("for Aug 2026", { timeout: 30_000 });
  });

  test("Step 3: Use auto → back to 'Sep 2026 · auto'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await openBill(page);
    await row.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Use auto" }).click();
    await expect(page.getByTestId(`bill-${BILL_ID}-service-period`)).toContainText("Sep 2026 · auto", { timeout: 30_000 });
  });
});
