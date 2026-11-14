/**
 * Card test — R-2767 (R-2742: wording + noise + USD). Run: `node scripts/ops/card-tests.mjs R-2767`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): an overseas customer
 * (country United States) with a subscription renewing in 12 days (tab 8–30) whose sale quote Q-CT2767-S is in
 * USD at ₹90 / $ — term ₹2,16,000 → "$2,400.00/yr · no GST (LUT)". Nobody owns the renewal.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2767000-0000-4000-8000-000000000001";
const SUB = "c2767000-0000-4000-8000-000000000021";
const NAME = "CT R2767 Overseas Customer Inc";
const PLAN = "CT R2767 USD Plan";
const db = () => localDb("R-2767");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set quote_id = null where id = '${SUB}' and tenant_id = ${T};
    delete from public.quotes where id = 'Q-CT2767-S' and tenant_id = ${T};
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, country)
      values ('${CUST}', ${T}, '${NAME}', 'ap.ct2767@example.test', 'United States');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, currency, exchange_rate, line_items)
      values ('Q-CT2767-S', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', public.ist_today() - 353, 216000, 216000, 0, 'USD', 90, '[]');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, term_amount, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, quote_id)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 18000, 12, 216000, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 'Q-CT2767-S');
    commit;`);
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  const search = page.getByRole("searchbox", { name: /Search renewals/ });
  await search.fill("CT R2767");
  const row = (width >= 1260 ? page.locator("tr", { hasText: PLAN }) : page.getByTestId("renewals-cards").locator("li", { hasText: PLAN })).filter({ visible: true });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect(row.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 60_000 });
  return row;
}

test.describe("R-2767 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: a USD customer's renewal reads '$2,400.00/yr · no GST (LUT)' in the table — never '₹… + GST'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await open(page, 1568);
    await expect(row).toContainText("$2,400.00/yr");
    await expect(row).toContainText("no GST (LUT)");
    await expect(row).not.toContainText("₹2,16,000");
    await expect(row).not.toContainText("+ GST");
    await page.context().close();
  });

  test("Step 2: the card layout (900px) says the same and shows no 'No owner' / 'No expiry set' / 'Not contacted'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await open(page, 900);
    await expect(row).toContainText("$2,400.00/yr");
    for (const noise of ["No owner", "No expiry set", "Not contacted"]) await expect(row).not.toContainText(noise);
    await page.context().close();
  });

  test("Step 3: the row's button says 'Send renewal' (one verb), never 'Review renewal quote'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const row = await open(page, 1568);
    await expect(row.getByTestId("stage-primary")).toHaveText(/Send renewal/);
    await expect(row).not.toContainText("Review renewal quote");
    await page.context().close();
  });
});
