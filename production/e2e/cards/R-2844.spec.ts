/**
 * Card test — R-2844 "Renewals history H9: drawer Timeline tab".
 *
 * The Renewals drawer's History section has a fifth tab, Timeline: the renewal's whole story on ONE list,
 * newest first — the payment, the call logged (with its promise), the reminder email, the invoice raised and
 * the quote. Each line says what it is (Payment / Follow-up / Reminder / Invoice / Quote). Arrow keys reach
 * the tab; nothing spills sideways in the 480px drawer. Run: `node scripts/ops/card-tests.mjs R-2844`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer, one
 * yearly subscription renewing in 12 days; quote Q-CT2844-A (20 days ago) → INV-CT2844-A (15 days ago,
 * paid); a renewal reminder email (10 days ago); a call logged with a promise (5 days ago); a UPI payment
 * of ₹11,800 on the quote (3 days ago).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2844000-0000-4000-8000-000000000001";
const SUB = "c2844000-0000-4000-8000-000000000021";
const PAY = "c2844000-0000-4000-8000-000000000041";
const FU = "c2844000-0000-4000-8000-000000000051";
const NAME = "CT R2844 Timeline Traders";
const PLAN = "CT R2844 Workspace Yearly";
const db = () => localDb("R-2844");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2844", {
    invoiceIds: ["INV-CT2844-A"],
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             delete from public.payment_followups where id = '${FU}' and tenant_id = ${T};
             delete from public.renewal_email_log where subscription_id = '${SUB}' and tenant_id = ${T};
             update public.subscriptions set quote_id = null where id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id = 'Q-CT2844-A' and tenant_id = ${T};`,
    after: `delete from public.quotes where id = 'Q-CT2844-A' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', '${PLAN}', 'qty', 10, 'rate', 1000, 'commitment', 'annual_yearly'))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2844@example.test', '+91 98765 28440', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 983, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'reminder_1', true, 0, 1);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2844-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 20, 11800, 10000, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2844-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2844-A', 'paid', 11800, 1800, 11800, public.ist_today() - 15, public.ist_today() - 5);
    update public.quotes set invoice_id = 'INV-CT2844-A' where id = 'Q-CT2844-A';
    update public.subscriptions set quote_id = 'Q-CT2844-A' where id = '${SUB}';
    insert into public.renewal_email_log (tenant_id, subscription_id, cadence_step, recipient_email, subject, status, sent_at)
      values (${T}, '${SUB}', 'reminder_1', 'ct2844@example.test', 'Renewal reminder', 'sent', now() - interval '10 days');
    insert into public.payment_followups (id, tenant_id, customer_id, subscription_id, kind, note, promised_on, promised_amount, created_by, created_at)
      values ('${FU}', ${T}, '${CUST}', '${SUB}', 'call', 'CT R2844 will pay this week', public.ist_today() - 3, 11800, null, now() - interval '5 days');
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY}', ${T}, 'Q-CT2844-A', '${CUST}', 11800, 'upi', 'CTUTR2844', 'received', now() - interval '3 days', 'Card test R-2844 — local only');
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

test.describe("R-2844 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: History shows a 'Timeline 5' tab next to Payments", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, 1280);
    const history = drawer.getByTestId("renewal-drawer-history");
    await expect(history.getByRole("tab")).toHaveText(["All3", "Quotes1", "Invoices1", "Payments1", "Timeline5"], { timeout: 60_000 });
  });

  for (const width of [1276, 1280]) {
    test(`Step 2${width === 1276 ? "" : "b"}: at ${width}px Timeline lists payment, call, reminder, invoice, quote — newest first, no side scroll`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      const drawer = await openDrawer(page, width);
      const history = drawer.getByTestId("renewal-drawer-history");
      const timeline = history.getByRole("tab", { name: /^Timeline/ });
      await expect(timeline).toBeVisible({ timeout: 60_000 });
      await timeline.click();
      await expect(timeline).toHaveAttribute("aria-selected", "true");
      const items = history.getByRole("tabpanel").locator("ul > li");
      await expect(items).toHaveCount(5, { timeout: 60_000 });
      await expect(items.nth(0)).toContainText(/^Payment.* · UPI · for INV-CT2844-A/);
      await expect(items.nth(0)).toContainText("₹11,800");
      await expect(items.nth(0)).toContainText("Ref CTUTR2844");
      await expect(items.nth(1)).toContainText(/^Follow-up.* · Call/);
      await expect(items.nth(1)).toContainText("CT R2844 will pay this week");
      await expect(items.nth(1)).toContainText(/Promised .* · ₹11,800/);
      await expect(items.nth(2)).toContainText(/^Reminder.* · Email · /);
      await expect(items.nth(2)).toContainText("Sent");
      await expect(items.nth(3)).toHaveAttribute("data-doc", "INV-CT2844-A");
      await expect(items.nth(4)).toHaveAttribute("data-doc", "Q-CT2844-A");
      const spill = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
    });
  }

  test("Step 3: arrow keys reach Timeline (End) and go back to Payments (Left)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, 1280);
    const history = drawer.getByTestId("renewal-drawer-history");
    const all = history.getByRole("tab", { name: /^All/ });
    await expect(all).toBeVisible({ timeout: 60_000 });
    await all.focus();
    await page.keyboard.press("End");
    await expect(history.getByRole("tab", { name: /^Timeline/ })).toHaveAttribute("aria-selected", "true");
    await expect(history.getByRole("tab", { name: /^Timeline/ })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(history.getByRole("tab", { name: /^Payments/ })).toHaveAttribute("aria-selected", "true");
  });
});
