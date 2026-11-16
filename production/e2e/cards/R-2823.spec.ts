/**
 * Card test — R-2823 "Subscription: vendor (Google/Microsoft) renewal date + hold in words on Renewals"
 * (Renewals 12-question audit, 14 Nov 2026).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2823`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 * customer "CT R2823 Vendor Co", plan "CT R2823 Google Plan" (Google, yearly), renewal date 5 days ago
 * and not paid → on hold at Google (Overdue tab).
 *   Step 1: the row reads "Hold at Google — unpaid" next to the lock.
 *   Step 2: Correct details (Subscriptions → ⋮) has "Google renewal date"; type today + 60 days, Save.
 *   Step 3: the drawer's Terms read "Google renews <that date>".
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2823000-0000-4000-8000-000000000001";
const SUB = "c2823000-0000-4000-8000-000000000002";
const NAME = "CT R2823 Vendor Co";
const PLAN = "CT R2823 Google Plan";
const db = () => localDb("R-2823");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    set local session_replication_role = replica;
    delete from public.contract_amendments where subscription_id = '${SUB}';
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2823@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 5, 500, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 'ct2823.example');
    commit;`);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const vendorDate = () => db().one(`select (public.ist_today() + 60)::text`);

async function openCorrectDetails(page: Page) {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  await page.getByRole("searchbox", { name: /Search subscriptions/ }).or(page.getByLabel("Search subscriptions")).first().fill("CT R2823");
  const menu = page.getByRole("button", { name: new RegExp(`^Actions for ${PLAN} — `) }).filter({ visible: true });
  await expect(menu.first()).toBeVisible({ timeout: 60_000 });
  await menu.first().click();
  await page.getByRole("menuitem", { name: /Correct details/ }).click();
  const dlg = page.getByRole("dialog", { name: "Correct subscription" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  return dlg;
}

test.describe("R-2823 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals → Overdue: the row reads 'Hold at Google — unpaid' next to the lock (1276 wide)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1276, height: 800 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const row = page.locator("tr", { hasText: PLAN }).filter({ visible: true });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    const hold = await onlyOne(row.locator('[data-flag="vendorHold"]'), "hold flag");
    await expect(hold).toHaveText("Hold at Google — unpaid", { timeout: 60_000 });
    await expect(hold.locator("svg")).toHaveCount(1);
    /* fits at 1276: the words stay inside their own cell (never run over the next column) */
    await hold.scrollIntoViewIfNeeded();
    const box = await hold.boundingBox();
    const cell = await hold.locator("xpath=ancestor::td[1]").boundingBox();
    expect(box && cell && box.x + box.width <= cell.x + cell.width + 0.5).toBe(true);
  });

  test("Step 2: Subscriptions → ⋮ → Correct details: 'Google renewal date' saves with the one Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openCorrectDetails(page);
    const field = dlg.getByLabel("Google renewal date");
    await expect(field).toHaveValue("");
    const d = vendorDate();
    await field.fill(d);
    await expect(field).toHaveValue(d);
    await dlg.getByRole("button", { name: /Save changes/ }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    await expect.poll(() => db().one(`select coalesce(vendor_term_end::text, '') from public.subscriptions where id = '${SUB}'`), { timeout: 30_000 }).toBe(d);
  });

  test("Step 3: the Renewals drawer's Terms read 'Google renews <date>'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1276, height: 800 });
    await openAppPage(page, `/renewals?bucket=overdue&sub=${SUB}`);
    const drawer = page.getByTestId("renewal-drawer");
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByTestId("renewal-drawer-vendor-term")).toHaveText(`Google renews ${dmy(vendorDate())}`, { timeout: 60_000 });
  });
});
