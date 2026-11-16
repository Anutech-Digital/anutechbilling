/**
 * Card test — R-2845 (rev-r2831 M1): the Bill together dialog sends the parts it SHOWS.
 *  - Step 1: Create on a 2-subscription group → the POST carries `periods` [{subscriptionId, periodStart}] for both
 *    ticked lines; the proforma made bills exactly those parts (the laid parts in the DB have those starts) and opens.
 *  - Step 2: the "invoice" answer (money already received pays the group) — needs pool money the local company does
 *    not have; unit-tested in bill-together-r2845.test.tsx (toast words + the invoice opens).
 * Run: `node scripts/ops/card-tests.mjs R-2845`.
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2845 Paise Co with two
 * MONTHLY subscriptions whose term ended 5 days ago; last month's parts on ONE paid invoice (R-2832's shape, own ids).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2845000-0000-4000-8000-000000000001";
const SUB_A = "c2845000-0000-4000-8000-000000000021";
const SUB_B = "c2845000-0000-4000-8000-000000000022";
const BILL_A0 = "c2845000-0000-4000-8000-000000000031";
const BILL_B0 = "c2845000-0000-4000-8000-000000000032";
const NAME = "CT R2845 Paise Co";
const PLAN_A = "CT R2845 Workspace Standard";
const PLAN_B = "CT R2845 Workspace Starter";
const PREV_INV = "INV-CT2845-PREV";
const PREV_PI = "PI-CT2845-PREV";
const db = () => localDb("R-2845");
const T = E2E_TENANT_SQL;
const SUBS = `('${SUB_A}', '${SUB_B}')`;
const OLD_RENEWAL = "(public.ist_today() - 5)";

function clean(): void {
  const parts = `(select b.id from public.subscription_billings b where b.subscription_id in ${SUBS})`;
  const reqs = `(select q.id from public.quotes q where q.id = '${PREV_PI}' or q.subscription_billing_id in ${parts} or q.cancelled_part_billing_id in ${parts}
                  or exists (select 1 from jsonb_array_elements(coalesce(q.line_items, '[]'::jsonb)) l where l->>'billing_id' in (select b.id::text from public.subscription_billings b where b.subscription_id in ${SUBS})))`;
  const invoiceIds = db().psql(`select distinct b.invoice_id from public.subscription_billings b where b.subscription_id in ${SUBS} and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2845", {
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
      values ('${CUST}', ${T}, '${NAME}', 'ct2845@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'google', 3, 4755.3, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2845-paise.test'),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'google', 7, 3151.4, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2845-paise.test');
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
      values (${T}, '${PREV_PI}', 9329.74, 'bank_transfer', 'CT-R2845-PREV', 'received', now() - interval '33 days');
    commit;`);
}

const rowOf = (page: Page, plan: string) => page.locator("tr").filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) });

test.describe("R-2845 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Bill together → Create sends the shown parts (periods) and the proforma bills exactly those", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    await expect(rowOf(page, PLAN_A).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
    /* wait for what you click (R-2666): on a busy dev server the group paints after the table */
    const bt = page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ });
    await expect(bt).toBeVisible({ timeout: 60_000 });
    await bt.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
    const create = dlg.getByRole("button", { name: "Create proforma" });
    await expect(create).toBeEnabled({ timeout: 60_000 });
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/renewals/bill-together"), { timeout: 60_000 }),
      create.click(),
    ]);
    const body = req.postDataJSON() as { ids: string[]; periods: Array<{ subscriptionId: string; periodStart: string }> };
    expect([...body.ids].sort()).toEqual([SUB_A, SUB_B].sort());
    expect(body.periods.map((p) => p.subscriptionId).sort()).toEqual([SUB_A, SUB_B].sort());
    for (const p of body.periods) expect(p.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page).toHaveURL(/\/quotes\/PI-/, { timeout: 120_000 });
    /* the parts on the new proforma start exactly where the dialog said */
    for (const p of body.periods) {
      const n = db().one(`select count(*) from public.subscription_billings where tenant_id = ${T} and subscription_id = '${p.subscriptionId}' and period_start = '${p.periodStart}'::date and invoice_id is null`);
      expect(Number(n), `laid part of ${p.subscriptionId} from ${p.periodStart}`).toBe(1);
    }
    await page.context().close();
  });

  test("Step 2: an 'invoice' answer says 'Invoice <no> — already paid from money received' and opens the invoice", async () => {
    test.skip(true, "needs money received (pool) covering the group — not in the local company; unit-tested: bill-together-r2845.test.tsx (2)");
  });
});
