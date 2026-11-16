/**
 * Card test — R-2862 "Renewals part-billed leftovers: sidebar badge, drawer 'Unpaid part', Overdue tile".
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2862` (the local DB needs migration *_r2862_nav_badges_part_due — `npm run localhost:update`).
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2862 Annual Part Co —
 * one ANNUAL subscription paid quarterly (₹12,000 a year, ₹3,000 a part) that renews in 40 days, whose part's payment
 * request (PI-CT2862-1) was due 5 days ago and is unpaid. By its renewal date it is a "31–60" row; by its part it is Overdue.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2862000-0000-4000-8000-000000000001";
const SUB = "c2862000-0000-4000-8000-000000000021";
const BILL = "c2862000-0000-4000-8000-000000000031";
const QUOTE = "PI-CT2862-1";
const NAME = "CT R2862 Annual Part Co";
const PLAN = "CT R2862 Annual Plan";
const db = () => localDb("R-2862");
const T = E2E_TENANT_SQL;
const RENEWS = "(public.ist_today() + 40)";
const PART_START = "(public.ist_today() - 5)";

function clean(): void {
  db().psql(`begin;
    delete from public.quotes where id = '${QUOTE}' and tenant_id = ${T};
    delete from public.subscription_billings where id = '${BILL}' and tenant_id = ${T};
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2862@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 4, 1000, 12, 'quarterly',
              (${RENEWS} - interval '2 years')::date, ${RENEWS}, 'active', 'pending', true, 0);
    -- a part of a later term than the first: asked 5 days ago (due_on), unpaid
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, due_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL}', ${T}, '${SUB}', ${PART_START}, 1, ${PART_START}, ${PART_START}, ${PART_START}, (${PART_START} + interval '3 months')::date, 3000, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('${QUOTE}', ${T}, '${CUST}', '${NAME}', 'sent', 'awaiting', '${BILL}', ${PART_START}, 3540, 3000, 18, '[]');
    commit;`);
}

/** The open tab's table once every chip has loaded (no "Loading status" skeleton left). */
async function loadedTable(page: Page): Promise<Locator> {
  const table = page.getByTestId("renewals-table");
  /* the tiles show once, from final data (R-2855) — after that no row changes tab any more */
  await expect(page.getByTestId("renewal-tile-loading")).toHaveCount(0, { timeout: 120_000 });
  await expect(table.getByTestId("renewal-row").first()).toBeVisible({ timeout: 90_000 });
  await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
  return table;
}

/** Every row of the open tab on screen ("Show more" pressed until it is gone), then { rows, Won't renew rows }. */
async function tabRows(page: Page): Promise<{ rows: number; wontRenew: number }> {
  const table = await loadedTable(page);
  const more = page.getByTestId("renewals-show-more");
  for (let i = 0; i < 40 && (await more.count()) > 0; i++) await more.first().click();
  await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
  return {
    rows: await table.getByTestId("renewal-row").count(),
    wontRenew: await table.getByTestId("renewal-row").filter({ has: page.locator('[data-testid="stage-chip"][data-stage="ending"]') }).count(),
  };
}

/* one login for all steps (a busy dev server timed out the second test-login) */
let shared: Page | null = null;
async function open(browser: Browser, baseURL: string | undefined, query: string): Promise<Page> {
  if (!shared) shared = await pageAs(browser, baseURL, "owner");
  await shared.setViewportSize({ width: 1280, height: 900 });
  await openAppPage(shared, `/renewals?${query}`, /Renewals/);
  return shared;
}

test.describe("R-2862 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: the sidebar Renewals number = Overdue + ≤7 days rows (less Won't renew); the late-part row is in Overdue", async ({ browser, baseURL }) => {
    test.setTimeout(420_000);
    const page = await open(browser, baseURL, "bucket=overdue");
    const overdue = await tabRows(page);
    await onlyOne(page.getByTestId("renewals-table").getByTestId("renewal-row").filter({ hasText: NAME }), "the CT R2862 row in Overdue");
    await open(browser, baseURL, "bucket=due7");
    await expect(page.getByRole("tab", { name: /≤7 days/ }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("renewal-tile-loading")).toHaveCount(0, { timeout: 120_000 });
    const due7 = (await page.getByTestId("renewals-table").getByTestId("renewal-row").count()) > 0 ? await tabRows(page) : { rows: 0, wontRenew: 0 };
    const want = overdue.rows - overdue.wontRenew + due7.rows - due7.wontRenew;
    /* the badge is read on a fresh load, after the rows above are known */
    await page.reload();
    const badge = await onlyOne(page.getByRole("link", { name: /renewals? overdue or due within 7 days/ }), "the sidebar Renewals badge");
    await expect(badge).toHaveText(String(want), { timeout: 60_000 });
  });

  test("Step 2: the drawer names the unpaid part and its value before 'Next term'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await open(browser, baseURL, `bucket=overdue&sub=${SUB}`);
    const drawer = page.getByTestId("renewal-drawer");
    await expect(drawer).toBeVisible({ timeout: 90_000 });
    const part = drawer.getByTestId("renewal-drawer-unpaid-part");
    await expect(part).toContainText("₹3,000 + GST", { timeout: 120_000 });
    const terms = await drawer.getByTestId("renewal-drawer-terms").innerText();
    expect(terms.indexOf("Unpaid part")).toBeGreaterThan(-1);
    expect(terms.indexOf("Unpaid part")).toBeLessThan(terms.indexOf("Next term"));
    /* the row's amount stays the whole term */
    expect(terms).toContain("₹12,000/yr");
  });

  test("Step 3: the Overdue tile says a part-billed renewal adds its unpaid part only", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await open(browser, baseURL, "bucket=overdue");
    await loadedTable(page);
    const tile = page.getByTitle(/^Overdue: .*A renewal billed in parts with one part unpaid adds that part only\./);
    await expect(tile.first()).toBeVisible({ timeout: 120_000 });
  });
});
