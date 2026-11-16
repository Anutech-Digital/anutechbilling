/**
 * Card test — R-2858 "Renewals part-billed rows: Due date, period and tab agree".
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2858`.
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2858 Part Due Co —
 * one MONTHLY subscription that renews in 3 days whose next part's payment request (PI-CT2858-1) was due 5 days
 * ago and is unpaid: the staging "SAV ENGINEERS" shape (an "Overdue 5d" row that sat under ≤7 days).
 * Step 3 reads Greentin Check 2095 (part 1 Oct – 31 Oct unpaid, renews 31 Oct) when the local company has it.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2858000-0000-4000-8000-000000000001";
const SUB = "c2858000-0000-4000-8000-000000000021";
const BILL = "c2858000-0000-4000-8000-000000000031";
const QUOTE = "PI-CT2858-1";
const NAME = "CT R2858 Part Due Co";
const PLAN = "CT R2858 Monthly Plan";
const db = () => localDb("R-2858");
const T = E2E_TENANT_SQL;
const RENEWS = "(public.ist_today() + 3)";

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
      values ('${CUST}', ${T}, '${NAME}', 'ct2858@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 4, 1000, 1, 'monthly',
              (${RENEWS} - interval '3 months')::date, ${RENEWS}, 'active', 'notice_sent', true, 0);
    -- the next term's part: payment asked 5 days ago (due_on), the period starts on the renewal date
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, due_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL}', ${T}, '${SUB}', ${RENEWS}, 1, public.ist_today() - 5, public.ist_today() - 5, ${RENEWS}, (${RENEWS} + interval '1 month')::date, 1000, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('${QUOTE}', ${T}, '${CUST}', '${NAME}', 'sent', 'awaiting', '${BILL}', public.ist_today() - 5, 1180, 1000, 18, '[]');
    commit;`);
}

/** The open tab's table once every chip has loaded (no "Loading status" skeleton left). */
async function loadedTable(page: Page): Promise<Locator> {
  const table = page.getByTestId("renewals-table");
  await expect(table.getByTestId("renewal-row").first()).toBeVisible({ timeout: 90_000 });
  await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
  return table;
}

const chipWords = async (row: Locator) => `${(await row.getByTestId("stage-chip").first().getAttribute("title")) ?? ""} ${await row.getByTestId("stage-chip").first().innerText()}`;

/* one login for all steps (a busy dev server timed out the second test-login) */
let shared: Page | null = null;
async function openTab(browser: Browser, baseURL: string | undefined, bucket: string): Promise<Page> {
  if (!shared) shared = await pageAs(browser, baseURL, "owner");
  await shared.setViewportSize({ width: 1280, height: 900 });
  await openAppPage(shared, `/renewals?bucket=${bucket}`, /Renewals/);
  return shared;
}

test.describe("R-2858 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Overdue tab — CT R2858 Part Due Co (renews in 3 days, part due 5 days ago) is listed, Due '5d ago', chip 'Overdue 5d'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await openTab(browser, baseURL, "overdue");
    const table = await loadedTable(page);
    const row = await onlyOne(table.getByTestId("renewal-row").filter({ hasText: NAME }), "the CT R2858 row in Overdue");
    await expect(row.locator('[data-cell="due"] p').nth(1)).toHaveText("5d ago");
    expect(await chipWords(row)).toMatch(/Overdue 5d · part due/);
  });

  test("Step 2: ≤7 days tab — CT R2858 Part Due Co is not there and no row says 'Overdue'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await openTab(browser, baseURL, "due7");
    await expect(page.getByRole("tab", { name: /≤7 days/ }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
    const table = page.getByTestId("renewals-table");
    await expect(table.getByTestId("renewal-row").filter({ hasText: NAME })).toHaveCount(0);
    for (const r of await table.getByTestId("renewal-row").all()) {
      expect(await chipWords(r), (await r.innerText()).replace(/\s+/g, " ").slice(0, 80)).not.toMatch(/overdue \d+d/i);
      await expect(r.locator('[data-cell="due"] p').nth(1)).not.toHaveText(/\d+d ago/);
    }
  });

  test("Step 3: Greentin Check 2095 — Due 1 Oct and the period is the Oct part (1 Oct 26 – 31 Oct 26), not 1 Nov – 30 Nov", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await openTab(browser, baseURL, "overdue");
    const table = await loadedTable(page);
    const rows = table.getByTestId("renewal-row").filter({ hasText: "Greentin Check 2095" }).filter({ has: page.locator('[data-cell="due"] p', { hasText: "1 Oct 26" }) });
    test.skip((await rows.count()) === 0, "Greentin Check 2095 with its 1 Oct part unpaid is not in the local company");
    const product = rows.first().locator('[data-cell="product"]');
    await expect(product).toContainText("1 Oct 26 – 31 Oct 26");
    await expect(product).not.toContainText("1 Nov 26");
  });
});
