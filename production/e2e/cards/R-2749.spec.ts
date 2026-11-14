/**
 * Card test — R-2749 "an undone renewal-part payment moves renewal_date back once" (written by R-2761, review
 * rev-r2749 LOW 4: the card had no e2e spec). The Renewals page, not only the database.
 *
 * One test per step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2749`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   CT R2749 Undo Pvt Ltd, one subscription billed quarterly on a 12-month term, renewal_date = today + 10.
 *   Its next term's first part is billed (bill_subscription_instalment — what "Bill next part" calls) and paid
 *   (a payment row, as every payment path writes) → renewed one term on. Step 2 takes the payment back
 *   (paid → pending: what a bank un-reconcile does; a full credit note goes the same way, R-2749 SQL test 1).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2749000-0000-4000-8000-000000000001";
const SUB = "c2749000-0000-4000-8000-000000000021";
const PART = "c2749000-0000-4000-8000-000000000031";
const NAME = "CT R2749 Undo Pvt Ltd";
const PLAN = "CT R2749 Undo Plan";
const db = () => localDb("R-2749");
const T = E2E_TENANT_SQL;
const OLD = "(public.ist_today() + 10)";
const NEW = `((${OLD} + interval '12 months')::date)`;

function clean(): void {
  const reqs = `(select q.id from public.quotes q where q.subscription_billing_id = '${PART}' or q.cancelled_part_billing_id = '${PART}')`;
  const invoiceIds = db().psql(`select b.invoice_id from public.subscription_billings b where b.id = '${PART}' and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2749", {
    invoiceIds: invoiceIds.length ? invoiceIds : ["INV-CT2749-NONE"],
    before: `delete from public.tds_receivable where payment_id in (select p.id from public.payments p where p.quote_id in ${reqs});
             delete from public.payments where quote_id in ${reqs} and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id = '${PART}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id in ${reqs} and tenant_id = ${T};`,
    after: `delete from public.quotes where id in ${reqs} and tenant_id = ${T};
            delete from public.subscription_billings where subscription_id = '${SUB}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2749@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'microsoft', 2, 200, 12, 'quarterly',
              (${OLD} - interval '12 months' + interval '1 day')::date, ${OLD}, 'active', 'grace_period', true);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                              period_end, taxable_amount, tax_rate, renews_from, renews_to)
      values ('${PART}', ${T}, '${SUB}', ${OLD} + 1, 1, ${OLD} + 1, ${OLD} + 1, (${OLD} + 1 + interval '3 months')::date,
              600, 18, ${OLD}, ${NEW});
    commit;`);
  const q = db().one(`select public.bill_subscription_instalment('${PART}'::uuid, false)->>'quote_id'`);
  /* record_payment — what Record payment / bank reconcile call (marks the proforma received, raises the paid invoice). */
  db().psql(`select public.record_payment('${q}', (select round(amount)::int from public.quotes where id = '${q}'), 'bank_transfer', 'CT-R2749-1', null);`);
  const renewed = db().one(`select (renewal_date = ${NEW})::text from public.subscriptions where id = '${SUB}'`);
  if (renewed !== "true") throw new Error("R-2749 seed: the paid part did not renew the subscription");
}

async function rowOn(page: Page, bucket: string): Promise<Locator> {
  await page.setViewportSize({ width: 1568, height: 900 });
  await openAppPage(page, `/renewals?bucket=${bucket}`, /Renewals/);
  /* R-2764: a tab shows 50 rows, then Show more — find ours by its customer (the page search). */
  await page.getByLabel("Search renewals by customer or domain").fill(NAME);
  const r = page.locator("tr", { hasText: PLAN }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  await expect(r.getByTestId("stage-chip")).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2749 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: renewal part paid → the row reads Renewed on the new date (one term on)", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOn(page, "later");
    await expect(r.getByTestId("stage-chip")).toContainText("Renewed");
    await page.context().close();
  });

  test("Step 2: the part's payment is taken back → renewal date back to the old date, row due again (not Renewed)", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    db().psql(`update public.invoices set status = 'pending', paid_date = null
               where id = (select invoice_id from public.subscription_billings where id = '${PART}');`);
    expect(db().one(`select (renewal_date = ${OLD})::text || ' ' || renewal_state from public.subscriptions where id = '${SUB}'`)).toBe("true pending");
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOn(page, "d30");
    await expect(r.getByTestId("stage-chip")).toContainText(/Invoiced · .* due|Due in 10d/);
    await expect(r.getByTestId("stage-chip")).not.toContainText("Renewed");
    await page.context().close();
  });
});
