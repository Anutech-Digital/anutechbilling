/**
 * Card test — R-2819 "Renewals drawer: Customer pays / Our cost / Margin (₹ and %), or 'Cost missing —
 * add in catalogue'".
 *
 * At 1276×800 (a 1280 laptop's inner width): the owner opens a renewal's drawer and reads, under Terms,
 * Customer pays ₹2,04,000/yr + GST · Our cost ₹1,48,800/yr (E2E catalogue Business Standard: ₹620 ×
 * 12 months × 20 seats — the renewal quote's own cost) · Margin ₹55,200/yr · 27%. A bespoke plan with no
 * catalogue row reads "Cost missing — add in catalogue" (a link to /items). A billing user (opens
 * Renewals, not the catalogue) sees only "Amount" — no cost, no margin.
 * Run: `BASE_URL=http://localhost:<your port> node scripts/ops/card-tests.mjs R-2819`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer,
 * two yearly subscriptions renewing in 20 days (tab 8–30): one on the catalogue's Business Standard
 * (no item_id — the confident match), one on a plan the catalogue does not have.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2819000-0000-4000-8000-000000000001";
const SUB_STD = "c2819000-0000-4000-8000-000000000021";
const SUB_BESPOKE = "c2819000-0000-4000-8000-000000000022";
const NAME = "CT R2819 Margin Traders";
const PLAN_STD = "Google Workspace Business Standard";
const PLAN_BESPOKE = "CT R2819 Bespoke Plan";
const db = () => localDb("R-2819");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    delete from public.subscriptions where id in ('${SUB_STD}', '${SUB_BESPOKE}') and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2819@example.test', '+91 98765 28190', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB_STD}', ${T}, '${CUST}', '${NAME}', '${PLAN_STD}', 'google', 20, 17000, 12, 'yearly',
              public.ist_today() - 345, public.ist_today() + 20, 'active', 'notice_sent', true, 0, 0),
             ('${SUB_BESPOKE}', ${T}, '${CUST}', '${NAME}', '${PLAN_BESPOKE}', 'google', 5, 2000, 12, 'yearly',
              public.ist_today() - 345, public.ist_today() + 20, 'active', 'notice_sent', true, 0, 0);
    commit;`);
}

async function openDrawer(page: Page, sub: string): Promise<ReturnType<Page["getByTestId"]>> {
  await page.setViewportSize({ width: 1276, height: 800 });
  await openAppPage(page, `/renewals?bucket=d30&sub=${sub}`);
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
  return drawer.getByTestId("renewal-drawer-terms");
}

test.describe("R-2819 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Owner at 1276: Customer pays ₹2,04,000/yr + GST · Our cost ₹1,48,800/yr · Margin ₹55,200/yr · 27%", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const terms = await openDrawer(page, SUB_STD);
    await expect(terms).toContainText("Customer pays", { timeout: 90_000 });   // after the signed-in user (role) loads
    await expect(terms).toContainText("₹2,04,000/yr");
    await expect(terms.getByTestId("renewal-drawer-cost")).toHaveText("₹1,48,800/yr", { timeout: 60_000 });
    await expect(terms.getByTestId("renewal-drawer-margin")).toHaveText("₹55,200/yr · 27%");
    const drawer = page.getByTestId("renewal-drawer");
    const spill = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("r2819-owner-margin.png") });
    await page.context().close();
  });

  test("Owner: a plan the catalogue lacks → 'Cost missing — add in catalogue' opens the catalogue", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const terms = await openDrawer(page, SUB_BESPOKE);
    const link = terms.getByRole("link", { name: "Cost missing — add in catalogue" });
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(link).toHaveAttribute("href", "/items");
    await expect(terms.getByTestId("renewal-drawer-margin")).toHaveText("Unknown — no cost");
    await page.screenshot({ path: test.info().outputPath("r2819-owner-missing.png") });
    await page.context().close();
  });

  test("Billing user: only Amount — no cost, no margin", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "billing");
    const terms = await openDrawer(page, SUB_STD);
    /* the sidebar menu renders only once the signed-in user (role) has loaded — then judge the drawer */
    await expect(page.locator("a[href=\"/renewals\"]").first()).toBeAttached({ timeout: 90_000 });
    await expect(terms).toContainText("Amount");
    await expect(terms).toContainText("₹2,04,000/yr");
    await expect(terms).not.toContainText("Our cost");
    await expect(terms).not.toContainText("Margin");
    await expect(terms).not.toContainText("Customer pays");
    await page.context().close();
  });
});
