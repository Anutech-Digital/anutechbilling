/**
 * Card test — R-2832 (rev-r2808 F3/F5): Bill together on Renewals.
 *  - the dialog shows paise (two decimals) on each line and on the total;
 *  - a group with one subscription unticked: the row hint says "Tick at least two — bills with …" and
 *    pressing it does NOT open a near-empty dialog (a note says what to do instead);
 *  - Renewals still fits 1280 / 1276.
 * F2 (one POST) and F6 (probe retry, no layout jump) are unit-tested: bill-together-r2832.test.tsx.
 * Run: `node scripts/ops/card-tests.mjs R-2832`.
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2832 Paise Co
 * with two MONTHLY subscriptions whose term ended 5 days ago; last month's parts of both on ONE paid invoice
 * INV-CT2832-PREV (paid through PI-CT2832-PREV, a receipt behind it) — the R-2808 card test's shape, own ids.
 * No proforma is made here.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2832000-0000-4000-8000-000000000001";
const SUB_A = "c2832000-0000-4000-8000-000000000021";
const SUB_B = "c2832000-0000-4000-8000-000000000022";
const BILL_A0 = "c2832000-0000-4000-8000-000000000031";
const BILL_B0 = "c2832000-0000-4000-8000-000000000032";
const NAME = "CT R2832 Paise Co";
const PLAN_A = "CT R2832 Workspace Standard";
const PLAN_B = "CT R2832 Workspace Starter";
const PREV_INV = "INV-CT2832-PREV";
const PREV_PI = "PI-CT2832-PREV";
const db = () => localDb("R-2832");
const T = E2E_TENANT_SQL;
const SUBS = `('${SUB_A}', '${SUB_B}')`;
const OLD_RENEWAL = "(public.ist_today() - 5)";
const MONEY = /₹[\d,]+\.\d{2}/;

function clean(): void {
  const parts = `(select b.id from public.subscription_billings b where b.subscription_id in ${SUBS})`;
  const reqs = `(select q.id from public.quotes q where q.id = '${PREV_PI}' or q.subscription_billing_id in ${parts} or q.cancelled_part_billing_id in ${parts}
                  or exists (select 1 from jsonb_array_elements(coalesce(q.line_items, '[]'::jsonb)) l where l->>'billing_id' in (select b.id::text from public.subscription_billings b where b.subscription_id in ${SUBS})))`;
  const invoiceIds = db().psql(`select distinct b.invoice_id from public.subscription_billings b where b.subscription_id in ${SUBS} and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2832", {
    invoiceIds: [...new Set([...invoiceIds, PREV_INV])],
    before: `delete from public.tds_receivable where payment_id in (select p.id from public.payments p where p.quote_id in ${reqs});
             delete from public.payments where quote_id in ${reqs} and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where subscription_id in ${SUBS} and tenant_id = ${T};
             update public.quotes set invoice_id = null where id in ${reqs} and tenant_id = ${T};`,
    after: `delete from public.quotes where id in ${reqs} and tenant_id = ${T};
            delete from public.subscription_billings where subscription_id in ${SUBS} and tenant_id = ${T};
            delete from public.subscriptions where id in ${SUBS} and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2832@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'google', 3, 4755.3, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2832-paise.test'),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'google', 7, 3151.4, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2832-paise.test');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('${PREV_INV}', ${T}, '${CUST}', '${NAME}', null, 'paid', 9329.74, 1423.04, 9329.74, public.ist_today() - 35, public.ist_today() - 30);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
      values ('${BILL_A0}', ${T}, '${SUB_A}', ((public.ist_today() - 4) - interval '12 months')::date, 11, public.ist_today() - 35,
              public.ist_today() - 35, public.ist_today() - 4, 4755.3, 18, '${PREV_INV}'),
             ('${BILL_B0}', ${T}, '${SUB_B}', ((public.ist_today() - 4) - interval '12 months')::date, 11, public.ist_today() - 35,
              public.ist_today() - 35, public.ist_today() - 4, 3151.4, 18, '${PREV_INV}');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, subscription_billing_id, invoice_id, line_items)
      values ('${PREV_PI}', ${T}, '${CUST}', '${NAME}', 'accepted', 9329.74, '${BILL_A0}', '${PREV_INV}', '[]'::jsonb);
    insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
      values (${T}, '${PREV_PI}', 9329.74, 'bank_transfer', 'CT-R2832-PREV', 'received', now() - interval '33 days');
    commit;`);
}

const rowOf = (page: Page, plan: string) => page.locator("tr").filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) });

async function openOverdue(page: Page): Promise<void> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  await expect(rowOf(page, PLAN_A).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
}

test.describe("R-2832 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Bill together dialog shows paise — every line and the total with two decimals", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    await page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
    for (const line of await dlg.getByTestId("bill-together-line").all()) await expect(line).toContainText(MONEY);
    await expect(dlg.getByTestId("bill-together-total")).toContainText(/₹[\d,]+\.\d{2} \+ GST ₹[\d,]+\.\d{2} = ₹[\d,]+\.\d{2}/);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: untick one in the Bill together box → the row says 'Tick at least two'; pressing it opens no dialog", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openOverdue(page);
    const group = page.getByTestId("bill-together-group").filter({ hasText: NAME });
    await group.getByRole("checkbox", { name: new RegExp(PLAN_B) }).click();
    const hint = rowOf(page, PLAN_A).getByTestId("renewal-bills-with");
    await expect(hint).toHaveText(`Tick at least two — bills with ${PLAN_B}`);
    await hint.click();
    await expect(page.getByText(`Tick at least two subscriptions of ${NAME} in the Bill together box above`)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    /* still fits 1280 / 1276 */
    for (const w of [1280, 1276]) {
      await page.setViewportSize({ width: w, height: 800 });
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(m.scroll, `no horizontal scroll at ${w}`).toBeLessThanOrEqual(m.inner);
    }
    await page.context().close();
  });
});
