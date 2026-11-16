/**
 * Card test — R-2853 "Every invoice of a subscription shows its subscription period under the invoice
 * number" (Pardeep, 16 Nov 2026: "agar invoice subscription ka hai to uske neeche subscription period
 * bhi show ho").
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2853`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2853 Periods Pvt Ltd":
 *   · INV-CT2853-Y — one yearly subscription line whose stored period (R-2744 service_period) is
 *     1 Oct 2026 – 30 Sep 2027 → "Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027";
 *   · INV-CT2853-P — the invoice of part 2 of a monthly-billed 12-month plan (subscription_billings,
 *     1 Oct – 1 Nov exclusive) → "Part 2 of 12 · 1–31 Oct 2026";
 *   · INV-CT2853-T — two subscriptions billed together (each line its own stored period) →
 *     "2 subscriptions · 1 Oct 2026 – 14 Nov 2027";
 *   · INV-CT2853-O — a one-time line only → no period line.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2853000-0000-4000-8000-000000000001";
const SUB_P = "c2853000-0000-4000-8000-000000000021";
const BILL_P = "c2853000-0000-4000-8000-000000000031";
const NAME = "CT R2853 Periods Pvt Ltd";
const INVOICES = ["INV-CT2853-Y", "INV-CT2853-P", "INV-CT2853-T", "INV-CT2853-O"];
const db = () => localDb("R-2853");
const T = E2E_TENANT_SQL;

const YEAR = "Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027";
const PART = "Part 2 of 12 · 1–31 Oct 2026";
const TOGETHER = "2 subscriptions · 1 Oct 2026 – 14 Nov 2027";

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2853", {
    invoiceIds: INVOICES,
    before: `update public.subscription_billings set invoice_id = null where id = '${BILL_P}' and tenant_id = ${T};`,
    after: `delete from public.subscription_billings where id = '${BILL_P}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB_P}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const sp = (from: string, to: string) => `jsonb_build_object('from', '${from}', 'to', '${to}', 'months', 12)`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2853@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, auto_renew)
      values ('${SUB_P}', ${T}, '${CUST}', '${NAME}', 'CT R2853 Monthly Plan', 'google', 5, 500, 12, 'monthly',
              '2026-09-01', '2027-09-01', 'active', true);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL_P}', ${T}, '${SUB_P}', '2026-09-01', 2, '2026-10-01', '2026-10-01', '2026-11-01', 1000, 18);
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, line_items)
      values ('INV-CT2853-Y', ${T}, '${CUST}', '${NAME}', null, 'paid', 14160, 2160, 14160, '2026-10-01',
              jsonb_build_array(jsonb_build_object('name', 'Google Workspace Business Starter', 'qty', 1, 'rate', 12000, 'commitment', 'annual_yearly',
                                                   'service_period', ${sp("2026-10-01", "2027-09-30")}))),
             ('INV-CT2853-P', ${T}, '${CUST}', '${NAME}', null, 'paid', 1180, 180, 1180, '2026-10-02',
              jsonb_build_array(jsonb_build_object('name', 'CT R2853 Monthly Plan (part 2 of 12)', 'qty', 1, 'rate', 1000))),
             ('INV-CT2853-T', ${T}, '${CUST}', '${NAME}', null, 'paid', 28320, 4320, 28320, '2026-10-03',
              jsonb_build_array(
                jsonb_build_object('name', 'Google Workspace Business Starter', 'qty', 1, 'rate', 12000, 'subscription_id', 'c2853000-0000-4000-8000-0000000000a1',
                                   'service_period', ${sp("2026-10-01", "2027-09-30")}),
                jsonb_build_object('name', 'Google Workspace Business Standard', 'qty', 1, 'rate', 12000, 'subscription_id', 'c2853000-0000-4000-8000-0000000000a2',
                                   'service_period', ${sp("2026-11-15", "2027-11-14")}))),
             ('INV-CT2853-O', ${T}, '${CUST}', '${NAME}', null, 'paid', 5900, 900, 5900, '2026-10-04',
              jsonb_build_array(jsonb_build_object('name', 'Setup fee', 'qty', 1, 'rate', 5000, 'one_time', true, 'service_period', null)));
    update public.subscription_billings set invoice_id = 'INV-CT2853-P' where id = '${BILL_P}';
    commit;`);
}

/** The visible /invoices row (desktop table) or card (below 1280) of one invoice. */
async function listItem(page: Page, id: string): Promise<Locator> {
  await openAppPage(page, `/invoices?q=CT2853`, /Invoices/);
  const item = page.locator("tr, li, a", { has: page.getByText(id, { exact: true }) }).filter({ visible: true }).last();
  await expect(item).toBeVisible({ timeout: 60_000 });
  return item;
}

test.describe("R-2853 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Invoices list (1280) — the period is under each subscription invoice number; a one-time invoice shows none", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const [id, text] of [["INV-CT2853-Y", YEAR], ["INV-CT2853-P", PART], ["INV-CT2853-T", TOGETHER]] as const) {
      const row = await listItem(page, id);
      await expect(await onlyOne(row.getByTestId("invoice-period"), `period of ${id}`)).toHaveText(text);
    }
    const oneOff = await listItem(page, "INV-CT2853-O");
    await expect(oneOff.getByTestId("invoice-period")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("Step 2: at 1276 and on a phone the invoice cards show the same line and the page does not scroll sideways", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    for (const width of [1276, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const card = await listItem(page, "INV-CT2853-Y");
      await expect(await onlyOne(card.getByTestId("invoice-period"), "card period")).toHaveText(YEAR);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test("Step 3: customer page → Transactions → Invoices shows the period under each invoice number", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAppPage(page, `/customers/${CUST}?tab=transactions&show=invoices`);
    for (const [id, text] of [["INV-CT2853-Y", YEAR], ["INV-CT2853-P", PART], ["INV-CT2853-T", TOGETHER]] as const) {
      const row = page.locator("tr", { has: page.getByRole("link", { name: id, exact: true }) }).filter({ visible: true });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await expect(row.getByTestId("invoice-period")).toHaveText(text);
    }
    const oneOff = page.locator("tr", { has: page.getByRole("link", { name: "INV-CT2853-O", exact: true }) }).filter({ visible: true });
    await expect(oneOff).toHaveCount(1);
    await expect(oneOff.getByTestId("invoice-period")).toHaveCount(0);
  });

  test("Step 4: the invoice page header shows the period under the number (yearly; a part bill its days under the 'Part 2 of 12' stamp)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    /* a part's page: the "Invoice for … Part 2 of 12" stamp above names the part, so the line under the number says its days */
    for (const [id, text] of [["INV-CT2853-Y", YEAR], ["INV-CT2853-P", "1–31 Oct 2026"]] as const) {
      await openAppPage(page, `/invoices/${id}`);
      const header = page.locator("[data-invoice-header]");
      await expect(header.getByRole("heading", { name: id })).toBeVisible({ timeout: 60_000 });
      await expect(header.getByTestId("invoice-period")).toHaveText(text, { timeout: 60_000 });
    }
    await openAppPage(page, "/invoices/INV-CT2853-P");
    await expect(page.getByTestId("invoice-kind")).toContainText("Part 2 of 12", { timeout: 60_000 });
    await openAppPage(page, "/invoices/INV-CT2853-O");
    await expect(page.locator("[data-invoice-header]").getByRole("heading", { name: "INV-CT2853-O" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("invoice-period")).toHaveCount(0);
  });
});
