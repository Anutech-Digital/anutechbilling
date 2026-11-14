/**
 * Card test — R-2740 "Renewals row drawer: all quotes + invoices (status + period), payments,
 * follow-ups, flags explained".
 *
 * At 1276×800 (a 1280 laptop's inner width) and 1568×900: the product name opens a right drawer
 * that lists EVERY quote + invoice of the subscription (a revised-away quote marked, the part
 * proforma + its overdue invoice with their month), the payment with its method and the invoice it
 * paid, the logged follow-up note, and each flag with one plain line; Esc closes it and focus goes
 * back to the product button; ?sub=<id> opens it straight away; nothing spills sideways.
 * Run: `node scripts/ops/card-tests.mjs R-2740`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer,
 * one quarterly-billed subscription renewing in 12 days (tab 8–30), previous term ₹98 unpaid:
 *   Q-CT2740-A  the original sale, invoiced → INV-CT2740-A (paid, UPI payment on it)
 *   Q-CT2740-R1 renewal quote, revised → replaced by Q-CT2740-R2 (sent)
 *   Q-CT2740-P  a part proforma for a billed quarter → INV-CT2740-P (overdue)
 *   a follow-up note "CT R2740 will pay on Friday".
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2740000-0000-4000-8000-000000000001";
const SUB = "c2740000-0000-4000-8000-000000000021";
const BILL = "c2740000-0000-4000-8000-000000000031";
const PAY = "c2740000-0000-4000-8000-000000000041";
const FU = "c2740000-0000-4000-8000-000000000051";
const NAME = "CT R2740 Drawer Traders";
const PLAN = "CT R2740 Workspace Quarterly";
const QUOTES = ["Q-CT2740-A", "Q-CT2740-R1", "Q-CT2740-R2", "Q-CT2740-P"];
const INVOICES = ["INV-CT2740-A", "INV-CT2740-P"];
const db = () => localDb("R-2740");
const T = E2E_TENANT_SQL;
const qList = QUOTES.map((q) => `'${q}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2740", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             delete from public.payment_followups where id = '${FU}' and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id = '${BILL}' and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null, superseded_by = null where id in (${qList}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${qList}) and tenant_id = ${T};
            delete from public.subscription_billings where id = '${BILL}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', '${PLAN}', 'qty', 10, 'rate', 650, 'commitment', 'annual_quarterly'))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2740@example.test', '+91 98765 40000', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 6500, 12, 'quarterly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 98, 2);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2740-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', public.ist_today() - 360, 92040, 78000, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2740-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2740-A', 'paid', 92040, 14040, 92040, public.ist_today() - 355, public.ist_today() - 340);
    update public.quotes set invoice_id = 'INV-CT2740-A' where id = 'Q-CT2740-A';
    update public.subscriptions set quote_id = 'Q-CT2740-A' where id = '${SUB}';
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2740-R1', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB}', public.ist_today() + 12, 12,
              public.ist_today() - 5, public.ist_today() + 10, 95580, 81000, 18, ${line});
    /* a revision, as the editor makes it: the new quote is not linked yet; marking the old one superseded
       moves the subscription link to it (R-2368 trigger) */
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, revision_of,
                               extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2740-R2', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, 'Q-CT2740-R1', 12,
              public.ist_today() - 2, public.ist_today() + 14, 92040, 78000, 18, ${line});
    update public.quotes set superseded_by = 'Q-CT2740-R2' where id = 'Q-CT2740-R1';
    update public.quotes set renewal_subscription_id = '${SUB}', renewal_term_date = public.ist_today() + 12
      where id = 'Q-CT2740-R2' and renewal_subscription_id is null;
    update public.subscriptions set renewal_quote_id = 'Q-CT2740-R2' where id = '${SUB}';
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL}', ${T}, '${SUB}', public.ist_today() - 353, 3, public.ist_today() - 80,
              public.ist_today() - 80, public.ist_today() + 12, 19500, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items, subscription_billing_id)
      values ('Q-CT2740-P', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 80, 23010, 19500, 18, ${line}, '${BILL}');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2740-P', ${T}, '${CUST}', '${NAME}', null, 'pending', 23010, 3510, 0, public.ist_today() - 80, public.ist_today() - 43);
    update public.subscription_billings set invoice_id = 'INV-CT2740-P' where id = '${BILL}';
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY}', ${T}, 'Q-CT2740-A', '${CUST}', 92040, 'upi', 'CTUTR2740', 'received', now() - interval '350 days', 'Card test R-2740 — local only');
    insert into public.payment_followups (id, tenant_id, customer_id, subscription_id, kind, note, next_follow_up_on, created_by)
      values ('${FU}', ${T}, '${CUST}', '${SUB}', 'call', 'CT R2740 will pay on Friday', public.ist_today() + 2, null);
    commit;`);
}

async function openList(page: Page, width: number, height: number, path = "/renewals?bucket=d30"): Promise<void> {
  await page.setViewportSize({ width, height });
  /* with ?sub= the drawer is a modal — the page heading behind it is hidden from the accessibility tree */
  await openAppPage(page, path, path.includes("sub=") ? undefined : /Renewals/);
}

async function drawerShowsTheStory(page: Page): Promise<void> {
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible();
  const docs = drawer.getByTestId("renewal-drawer-doc");
  const doc = (id: string) => docs.filter({ has: page.getByText(id, { exact: true }) });
  await expect(docs).toHaveCount(6, { timeout: 60_000 });   // 4 quotes + 2 invoices
  await expect(doc("Q-CT2740-R1")).toContainText("Revised — replaced by Q-CT2740-R2");
  await expect(doc("Q-CT2740-R2").getByTestId("renewal-drawer-doc-status")).toHaveText("Sent");
  await expect(doc("INV-CT2740-P").getByTestId("renewal-drawer-doc-status")).toHaveText(/^Overdue 43d · ₹23,010$/);
  await expect(doc("INV-CT2740-A").getByTestId("renewal-drawer-doc-status")).toHaveText("Paid");
  await expect(doc("INV-CT2740-P")).toContainText(" · for ");   // the billed quarter's period
  const pay = drawer.getByTestId("renewal-drawer-payment");
  await expect(pay).toHaveCount(1);
  await expect(pay).toContainText("UPI");
  await expect(pay).toContainText("INV-CT2740-A");
  await expect(pay).toContainText("₹92,040");
  await expect(drawer.getByTestId("renewal-drawer-followup")).toContainText("CT R2740 will pay on Friday");
  await expect(drawer.getByTestId("renewal-drawer-followups")).toContainText("2 reminders sent");
  const prior = drawer.locator('[data-testid="renewal-drawer-flag"][data-flag="priorTermUnpaid"]');
  await expect(prior).toContainText("Previous term ₹98 still unpaid");
  await expect(prior).toContainText("collect it along with this renewal");
  /* nothing spills sideways inside the drawer */
  const spill = await drawer.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
}

test.describe("R-2740 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  for (const [w, h] of [[1276, 800], [1568, 900]] as const) {
    test(`At ${w}: the product name opens the drawer with every quote + invoice, the payment, the follow-up and flags explained; Esc closes and focus returns`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await openList(page, w, h);
      const row = page.locator("tr", { hasText: PLAN }).filter({ visible: true });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      const opener = row.getByTestId("renewal-open-drawer");
      await opener.click();
      await expect(page).toHaveURL(new RegExp(`[?&]sub=${SUB}`));
      await drawerShowsTheStory(page);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("renewal-drawer")).toBeHidden();
      await expect(page).not.toHaveURL(/[?&]sub=/);
      await expect(opener).toBeFocused();
      await page.context().close();
    });
  }

  test("?sub=<id> opens the drawer straight away (a shared link)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openList(page, 1276, 800, `/renewals?bucket=d30&sub=${SUB}`);
    await drawerShowsTheStory(page);
    await page.context().close();
  });
});
