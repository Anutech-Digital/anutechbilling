/**
 * Card test — R-2838 "Renewals history H3: drawer History section with tabs".
 *
 * At 1276 and 1280 wide: the Renewals drawer has ONE "History" section right under the header (above
 * Terms) with tabs All · Quotes · Invoices · Payments (counts), a "Last quote · Last invoice · Last paid"
 * strip and a link to the customer's whole history. A ₹14,000 UPI receipt on a quote that was billed in
 * two invoices sits ₹10,000 under the older invoice and ₹4,000 under the newer one — once (the old drawer
 * listed the older invoice's money again as "no receipt"). The Payments tab lists it once, saying which
 * invoices it paid. Arrow keys move between tabs. Nothing spills sideways in the 480px drawer.
 * Run: `node scripts/ops/card-tests.mjs R-2838`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer, one
 * yearly subscription renewing in 12 days; quote Q-CT2838-A → INV-CT2838-A (paid ₹10,000) and a billed part
 * of the subscription → INV-CT2838-B (₹4,000 of ₹10,000 paid); one UPI payment of ₹14,000 on the quote.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2838000-0000-4000-8000-000000000001";
const SUB = "c2838000-0000-4000-8000-000000000021";
const PAY = "c2838000-0000-4000-8000-000000000041";
const BILL = "c2838000-0000-4000-8000-000000000031";
const NAME = "CT R2838 History Traders";
const PLAN = "CT R2838 Workspace Yearly";
const INVOICES = ["INV-CT2838-A", "INV-CT2838-B"];
const db = () => localDb("R-2838");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2838", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id = '${BILL}' and tenant_id = ${T};
             update public.subscriptions set quote_id = null where id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id = 'Q-CT2838-A' and tenant_id = ${T};`,
    after: `delete from public.quotes where id = 'Q-CT2838-A' and tenant_id = ${T};
            delete from public.subscription_billings where id = '${BILL}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', '${PLAN}', 'qty', 10, 'rate', 1695, 'commitment', 'annual_yearly'))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2838@example.test', '+91 98765 28380', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 1667, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 0, 0);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2838-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'partial', public.ist_today() - 360, 20000, 16949, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2838-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2838-A', 'paid', 10000, 1525, 10000, public.ist_today() - 355, public.ist_today() - 340),
             ('INV-CT2838-B', ${T}, '${CUST}', '${NAME}', null, 'pending', 10000, 1525, 4000, public.ist_today() - 170, public.ist_today() - 155);
    update public.quotes set invoice_id = 'INV-CT2838-A' where id = 'Q-CT2838-A';
    /* the second invoice = a billed part of the subscription (one invoice per quote is a database rule);
       a payment on the subscription's own quote settles over both, oldest first (R-1564 instalments) */
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
      values ('${BILL}', ${T}, '${SUB}', public.ist_today() - 353, 2, public.ist_today() - 170,
              public.ist_today() - 170, public.ist_today() + 12, 8475, 18, 'INV-CT2838-B');
    update public.subscriptions set quote_id = 'Q-CT2838-A' where id = '${SUB}';
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY}', ${T}, 'Q-CT2838-A', '${CUST}', 14000, 'upi', 'CTUTR2838', 'received', now() - interval '160 days', 'Card test R-2838 — local only');
    commit;`);
}

async function openDrawer(page: Page, width: number): Promise<ReturnType<Page["getByTestId"]>> {
  await page.setViewportSize({ width, height: 800 });
  await openAppPage(page, `/renewals?bucket=d30&sub=${SUB}`);
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
  return drawer;
}

test.describe("R-2838 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  for (const width of [1276, 1280]) {
    test(`Step 1${width === 1276 ? "" : "b"}: at ${width}px one History section above Terms — tabs with counts, each payment under the invoice it paid, once`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      const drawer = await openDrawer(page, width);
      const history = drawer.getByTestId("renewal-drawer-history");
      await expect(history.getByRole("heading", { name: "History" })).toBeVisible();
      await expect(drawer.getByTestId("renewal-drawer-docs")).toHaveCount(0);
      await expect(drawer.getByTestId("renewal-drawer-payments")).toHaveCount(0);
      /* History comes before Terms */
      const order = await drawer.evaluate((el) => {
        const h = el.querySelector("[data-testid=renewal-drawer-history]")!;
        const t = el.querySelector("[data-testid=renewal-drawer-terms]")!;
        return h.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING;
      });
      expect(order).toBeTruthy();
      const tabs = history.getByRole("tab");
      await expect(tabs).toHaveText(["All4", "Quotes1", "Invoices2", "Payments1"], { timeout: 60_000 });
      await expect(history.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true");
      const doc = (id: string) => history.locator(`[data-testid=renewal-drawer-doc][data-doc="${id}"]`);
      await expect(doc("INV-CT2838-A").getByTestId("renewal-drawer-payment")).toHaveCount(1);
      await expect(doc("INV-CT2838-A").getByTestId("renewal-drawer-payment")).toContainText("₹10,000");
      await expect(doc("INV-CT2838-A").getByTestId("renewal-drawer-payment")).toContainText("part of ₹14,000");
      await expect(doc("INV-CT2838-B").getByTestId("renewal-drawer-payment")).toContainText("₹4,000");
      await expect(history.getByText(/no receipt in the app/)).toHaveCount(0);
      await expect(drawer.getByTestId("history-last-paid")).toHaveText(/^₹14,000 · /);
      await expect(drawer.getByTestId("history-last-invoice")).toHaveText(/^INV-CT2838-B · /);
      const spill = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
    });
  }

  test("Step 2: Payments tab lists the UPI receipt once at ₹14,000 'for INV-CT2838-A, INV-CT2838-B'; arrow keys move between tabs", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, 1280);
    const history = drawer.getByTestId("renewal-drawer-history");
    const all = history.getByRole("tab", { name: /^All/ });
    await all.focus();
    await page.keyboard.press("ArrowRight");
    await expect(history.getByRole("tab", { name: /^Quotes/ })).toHaveAttribute("aria-selected", "true");
    await expect(history.getByRole("tab", { name: /^Quotes/ })).toBeFocused();
    await page.keyboard.press("End");
    const payments = history.getByRole("tab", { name: /^Payments/ });
    await expect(payments).toHaveAttribute("aria-selected", "true");
    const pay = history.getByTestId("renewal-drawer-payment");
    await expect(pay).toHaveCount(1);
    await expect(pay).toContainText("UPI");
    await expect(pay).toContainText("for INV-CT2838-A, INV-CT2838-B");
    await expect(pay).toContainText("₹14,000");
    await page.keyboard.press("ArrowLeft");
    await expect(history.getByRole("tab", { name: /^Invoices/ })).toHaveAttribute("aria-selected", "true");
    await expect(history.locator("[data-testid=renewal-drawer-doc]")).toHaveCount(2);
    await expect(history.locator("[data-testid=renewal-drawer-doc][data-kind=quote]")).toHaveCount(0);
  });

  test("Step 3: 'All history for <customer> →' opens the customer's Transactions → Payments", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, 1280);
    const link = drawer.getByRole("link", { name: `All history for ${NAME} →` });
    await expect(link).toHaveAttribute("href", `/customers/${CUST}?tab=transactions&show=payments`);
  });
});
