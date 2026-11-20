/**
 * Card test — R-2949 (G-RECON): Invoices → "FY 2025-26 sales from Zoho" lists the invoices that will
 * be imported and lets the owner leave some out (one row, or every number starting with a prefix);
 * the list is remembered on the server.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2949`.
 *
 * Data: planted by this spec on the LOCAL docker DB (localDb) — a COMPLETE FY 2025-26 invoice read of
 * E2E Test Co with three made-up Zoho invoices (two "INV…", one "LSINV…") for one made-up customer,
 * and the company's books start set to 1 Apr 2025 for the run (put back afterwards). Fixed ids,
 * planted before and removed after. The test never presses Read from Zoho (that would call Zoho) and
 * never presses Import — Check first is a dry run that saves nothing. That a left-out invoice cannot
 * be imported even by a direct call is proven by sales-import-route-r2949.test.ts and
 * supabase/tests/r2949_zoho_fy_left_out.test.sql.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2949";
const CUSTOMER_ID = "c2949000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Leave Out Buyer R2949";
const IDS = ["r2949-k1", "r2949-k2", "r2949-k3"] as const;
const LS_NUMBER = "LSINV/25-26/R2949-03";
/* A made-up Delhi buyer (E2E Test Co is in Maharashtra → IGST). This exact data was run through the
   real import's dry run on the local DB: 3 imported, 0 refused. */
const BUYER_GSTIN = "07AAFCV5915P1ZP";

const facts = (zohoId: string, number: string, taxable: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  zohoId, number, date: "2025-08-12", dueDate: "2025-08-27", status: "paid", zohoCustomerId: "zc-r2949", customerName: CUSTOMER,
  gstin: BUYER_GSTIN, gstTreatment: "business_gst", appGstTreatment: "registered_regular", posStateCode: "07", billingAddress: null, billingCountry: null,
  currency: "INR", fxRate: null, taxable, tax: Math.round(taxable * 0.18), amount: taxable + Math.round(taxable * 0.18),
  roundOff: 0, adjustment: 0, tds: 0, tdsSection: null, taxRate: 18, head: "igst",
  lines: [{ zohoItemId: "", name: "Seat", description: "", hsn: "998315", qty: 1, rate: taxable, taxable, taxPercent: 18 }],
  problems: [], notes: [], ...extra,
});

let booksStartBefore = "";

function unplant(): void {
  const db = localDb(CARD);
  db.psql(`
delete from public.zoho_fy_left_out where tenant_id = ${E2E_TENANT_SQL} and kind = 'invoices'
   and ((rule = 'prefix' and value = 'LS') or (rule = 'doc' and value in ('${IDS.join("', '")}')));
delete from public.zoho_fy_scan where tenant_id = ${E2E_TENANT_SQL} and kind = 'invoices' and zoho_id in ('${IDS.join("', '")}');
delete from public.zoho_fy_scan_runs r where r.tenant_id = ${E2E_TENANT_SQL} and r.kind = 'invoices' and r.fy = '2025-26'
   and not exists (select 1 from public.zoho_fy_scan s where s.tenant_id = r.tenant_id and s.kind = 'invoices' and s.fy = '2025-26');
delete from public.customers where id = '${CUSTOMER_ID}' and tenant_id = ${E2E_TENANT_SQL};
`);
}

function plant(): void {
  const db = localDb(CARD);
  unplant();
  booksStartBefore = db.one(`select coalesce(books_start_date::text, '') from public.tenants where id = ${E2E_TENANT_SQL};`);
  db.psql(`
update public.tenants set books_start_date = '2025-04-01' where id = ${E2E_TENANT_SQL};
insert into public.customers (id, tenant_id, name, gstin, state_code, state, country, address, city, pin_code)
values ('${CUSTOMER_ID}', ${E2E_TENANT_SQL}, '${CUSTOMER}', '${BUYER_GSTIN}', '07', 'Delhi', 'India', 'Shop 1', 'New Delhi', '110005');
insert into public.zoho_fy_scan_runs (tenant_id, kind, fy, next_page, list_done)
select ${E2E_TENANT_SQL}, 'invoices', '2025-26', 2, true
on conflict (tenant_id, kind, fy) do update set list_done = true;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  (${E2E_TENANT_SQL}, 'invoices', '2025-26', '${IDS[0]}', 'INV/25-26/R2949-01', '2025-08-12', 'paid', '${facts(IDS[0], "INV/25-26/R2949-01", 1000)}'::jsonb, now()),
  (${E2E_TENANT_SQL}, 'invoices', '2025-26', '${IDS[1]}', 'INV/25-26/R2949-02', '2025-08-12', 'paid', '${facts(IDS[1], "INV/25-26/R2949-02", 20000, { tds: 2000, tdsSection: "194J" })}'::jsonb, now()),
  (${E2E_TENANT_SQL}, 'invoices', '2025-26', '${IDS[2]}', '${LS_NUMBER}', '2025-08-12', 'paid', '${facts(IDS[2], LS_NUMBER, 1346)}'::jsonb, now())
on conflict (tenant_id, kind, zoho_id) do update set payload = excluded.payload, detailed_at = excluded.detailed_at, fy = excluded.fy, number = excluded.number;
`);
}

function restore(): void {
  unplant();
  localDb(CARD).psql(`update public.tenants set books_start_date = ${booksStartBefore ? `'${booksStartBefore.replace(/[^0-9-]/g, "")}'` : "null"} where id = ${E2E_TENANT_SQL};`);
}

/** Invoices → the dialog, with its "To import" list on screen. */
async function openDialog(page: Page): Promise<{ dialog: Locator; list: Locator }> {
  await openAppPage(page, "/invoices");
  const open = page.getByRole("button", { name: "FY 2025-26 sales from Zoho" });
  await expect(open).toBeVisible({ timeout: 90_000 });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "FY 2025-26 sales from Zoho" });
  const list = dialog.getByTestId("fy-sales-to-import");
  await expect(list).toBeVisible({ timeout: 90_000 });
  return { dialog, list };
}

/** The number on the "Import N sales" button. */
async function importCount(dialog: Locator): Promise<number> {
  const b = dialog.getByRole("button", { name: /^Import [\d,]+ sales$/ });
  await expect(b).toBeVisible({ timeout: 60_000 });
  return Number(((await b.innerText()).match(/[\d,]+/) ?? ["0"])[0].replace(/,/g, ""));
}

test.describe("R-2949 — FY sales from Zoho: see what will be imported, leave some out", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) restore(); });

  let before = 0;

  test("Step 1 + 2: the dialog lists the invoices that will be imported — number, customer, total, TDS note", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const { dialog, list } = await openDialog(page);
    const row = (number: string) => list.getByRole("row").filter({ hasText: number });
    await expect(row("INV/25-26/R2949-01")).toContainText(CUSTOMER);
    await expect(row("INV/25-26/R2949-01")).toContainText("₹1,180");
    await expect(row("INV/25-26/R2949-02")).toContainText("₹23,600");
    await expect(row("INV/25-26/R2949-02")).toContainText("TDS ₹2,000 (194J)");
    await expect(row(LS_NUMBER)).toContainText("₹1,588");
    before = await importCount(dialog);
    expect(before).toBeGreaterThanOrEqual(3);
  });

  test("Step 3: 'Leave out numbers starting with' LS → that invoice moves to 'Left out by you', one fewer to import; Check first agrees", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const { dialog, list } = await openDialog(page);
    await fillKept(dialog.getByLabel("Leave out numbers starting with"), "ls");
    await list.getByRole("button", { name: "Leave out", exact: true }).click();
    const mine = dialog.getByTestId("fy-sales-left-out-by-you");
    await expect(mine).toBeVisible({ timeout: 60_000 });
    await expect(mine).toContainText("Numbers starting with LS");
    await expect(mine).toContainText(LS_NUMBER);
    await expect(list.getByRole("row").filter({ hasText: LS_NUMBER })).toHaveCount(0);
    expect(await importCount(dialog)).toBe(before - 1);

    await dialog.getByRole("button", { name: "Check first (nothing saved)" }).click();
    const result = dialog.getByRole("status").filter({ hasText: "Check result (nothing saved)" });
    await expect(result).toContainText(`${(before - 1).toLocaleString("en-IN")} sales`, { timeout: 120_000 });
    await expect(result).not.toContainText(LS_NUMBER);
  });

  test("Step 4: close and open again — LS is still left out; Take back brings it in again", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const { dialog, list } = await openDialog(page);
    const mine = dialog.getByTestId("fy-sales-left-out-by-you");
    await expect(mine).toContainText(LS_NUMBER, { timeout: 60_000 });
    await expect(list.getByRole("row").filter({ hasText: LS_NUMBER })).toHaveCount(0);
    expect(await importCount(dialog)).toBe(before - 1);

    await mine.getByRole("button", { name: "Take back numbers starting with LS" }).click();
    await expect(list.getByRole("row").filter({ hasText: LS_NUMBER })).toHaveCount(1, { timeout: 60_000 });
    expect(await importCount(dialog)).toBe(before);
  });

  test("Not a screen step: a left-out invoice cannot be imported by a direct call; other roles and other companies", async () => {
    test.skip(true, "proven without a browser: sales-import-route-r2949.test.ts (direct import call, roles 403, another company) and supabase/tests/r2949_zoho_fy_left_out.test.sql (direct RPC refused by the database)");
  });
});
