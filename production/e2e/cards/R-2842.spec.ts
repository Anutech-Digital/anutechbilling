/**
 * Card test — R-2842 "Renewals history H7: one way to payment history".
 *
 * Below 1260 px (cards, 1100 wide): the row shows ONE "History" button (R-2422's popover under Last paid is
 * gone); it opens the drawer on History's Payments tab (?view=payments, tab focused) and the payment is listed.
 * A row with no payment keeps the same single button, opening History on All.
 * Run: `node scripts/ops/card-tests.mjs R-2842`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer, one yearly
 * subscription renewing in 12 days; quote Q-CT2842-A -> INV-CT2842-A (part paid), one UPI payment on the quote.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2842000-0000-4000-8000-000000000001";
const SUB = "c2842000-0000-4000-8000-000000000021";
const PAY = "c2842000-0000-4000-8000-000000000041";
const NAME = "CT R2842 History Button Traders";
const PLAN = "CT R2842 Workspace Yearly";
const INVOICES = ["INV-CT2842-A"];
const db = () => localDb("R-2842");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2842", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             update public.subscriptions set quote_id = null where id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id = 'Q-CT2842-A' and tenant_id = ${T};`,
    after: `delete from public.quotes where id = 'Q-CT2842-A' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', '${PLAN}', 'qty', 10, 'rate', 1695, 'commitment', 'annual_yearly'))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2842@example.test', '+91 98765 28420', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 1667, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 0, 0);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2842-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'partial', public.ist_today() - 360, 20000, 16949, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2842-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2842-A', 'pending', 10000, 1525, 4000, public.ist_today() - 355, public.ist_today() - 340);
    update public.quotes set invoice_id = 'INV-CT2842-A' where id = 'Q-CT2842-A' and tenant_id = ${T};
    update public.subscriptions set quote_id = 'Q-CT2842-A' where id = '${SUB}' and tenant_id = ${T};
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY}', ${T}, 'Q-CT2842-A', '${CUST}', 14000, 'upi', 'CTUTR2842', 'received', now() - interval '160 days', 'Card test R-2842 — local only');
    commit;`);
}

const cardLi = (page: Page) => page.getByTestId("renewals-cards").locator("li", { hasText: PLAN });

test.describe("R-2842 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: at 1100 wide the card has ONE History button and no popover under Last paid", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1100, height: 800 });
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    const card = cardLi(page);
    await expect(card.getByRole("button", { name: /^History/ })).toHaveCount(1, { timeout: 90_000 });
    await expect(card.getByRole("button", { name: /last 3 payments/i })).toHaveCount(0);
    await expect(card.getByText("Last paid").first()).toBeVisible({ timeout: 90_000 });
  });

  test("Step 2: History opens the drawer on the Payments tab and lists the UPI payment", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1100, height: 800 });
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    const card = cardLi(page);
    await expect(card.getByText("Last paid").first()).toBeVisible({ timeout: 90_000 });
    await card.getByRole("button", { name: /^History/ }).click();
    const drawer = page.getByTestId("renewal-drawer");
    await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get("view")).toBe("payments");
    const history = drawer.getByTestId("renewal-drawer-history");
    await expect(history.getByRole("tab", { name: /^Payments/ })).toHaveAttribute("data-state", "active", { timeout: 10_000 });
    await expect(history.getByRole("tab", { name: /^Payments/ })).toBeFocused();
    await expect(history.getByRole("tabpanel")).toContainText("UPI", { timeout: 10_000 });
  });
});
