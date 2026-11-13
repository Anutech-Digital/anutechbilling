/**
 * Card test — R-2735 "Renewals: 'Bill next part' must NOT move the renewal date or mark the subscription
 * renewed until the part is PAID" (Pardeep, 13 Nov 2026: "jab tak payment na aaye renew to karna hi nahi").
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2735`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   CT R2735 Renew Pvt Ltd with two subscriptions billed half-yearly on a 12-month term whose term ended
 *   5 days ago (renewal_date = today − 5, the new term began today − 4), no sale quote, nothing billed:
 *   · A "CT R2735 Parts Plan"  — billed through the Renewals row's real button, then paid;
 *   · B "CT R2735 Cancel Plan" — billed through the same route, its proforma cancelled.
 * A payment is planted as the payment row every path (Record payment, bank reconcile, Razorpay) writes.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2735000-0000-4000-8000-000000000001";
const SUB_A = "c2735000-0000-4000-8000-000000000021";
const SUB_B = "c2735000-0000-4000-8000-000000000022";
const NAME = "CT R2735 Renew Pvt Ltd";
const PLAN_A = "CT R2735 Parts Plan";
const PLAN_B = "CT R2735 Cancel Plan";
const db = () => localDb("R-2735");
const T = E2E_TENANT_SQL;
const SUBS = `('${SUB_A}', '${SUB_B}')`;
const OLD_RENEWAL = "(public.ist_today() - 5)";
const NEW_RENEWAL = "(((public.ist_today() - 4) + interval '12 months')::date - 1)";

function clean(): void {
  const parts = `(select b.id from public.subscription_billings b where b.subscription_id in ${SUBS})`;
  const reqs = `(select q.id from public.quotes q where q.subscription_billing_id in ${parts} or q.cancelled_part_billing_id in ${parts})`;
  const invoiceIds = db().psql(`select b.invoice_id from public.subscription_billings b where b.subscription_id in ${SUBS} and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2735", {
    invoiceIds: invoiceIds.length ? invoiceIds : ["INV-CT2735-NONE"],
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
      values ('${CUST}', ${T}, '${NAME}', 'ct2735@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'microsoft', 5, 500, 12, 'half_yearly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'microsoft', 2, 200, 12, 'half_yearly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true);
    commit;`);
}

/** renewal_date (ISO) · renewal_state · whether it is still the old date. */
function subState(id: string): { date: string; state: string; old: boolean; renewedTo: boolean } {
  const [date, state, old, renewedTo] = db().one(
    `select s.renewal_date::text || '|' || s.renewal_state::text || '|' || (s.renewal_date = ${OLD_RENEWAL})::text || '|' || (s.renewal_date = ${NEW_RENEWAL})::text
       from public.subscriptions s where s.id = '${id}'`).split("|");
  return { date, state, old: old === "true", renewedTo: renewedTo === "true" };
}

/** The proforma of the subscription's new term (newest, not cancelled). */
function proformaOf(id: string): { id: string; amount: number } {
  const [qid, amount] = db().one(
    `select q.id || '|' || q.amount from public.quotes q join public.subscription_billings b on b.id = q.subscription_billing_id
      where b.subscription_id = '${id}' and q.cancelled_at is null order by q.created_at desc limit 1`).split("|");
  return { id: qid, amount: Number(amount) };
}

function pay(quoteId: string, amount: number, ref: string): void {
  db().psql(`insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
             values (${T}, '${quoteId}', ${amount}, 'bank_transfer', '${ref}', 'received', now());`);
}

async function rowOf(page: Page, bucket: string, plan: string) {
  await openAppPage(page, `/renewals?bucket=${bucket}`, /Renewals/);
  return page.locator("tr", { hasText: plan }).filter({ visible: true });
}

test.describe("R-2735 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Bill next part on a subscription due 5 days ago → proforma made; renewal date unchanged, not renewed; row stays in Overdue as 'Renewal quote sent'", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);   // two Renewals page loads + the bill on a busy dev server
    const page = await pageAs(browser, baseURL, "owner");
    const row = await rowOf(page, "overdue", PLAN_A);
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    const button = await onlyOne(row.getByRole("button", { name: /Bill (next part|renewal)/ }), "Bill button");
    await expect(button).toBeVisible({ timeout: 60_000 });
    const dlg = page.getByRole("dialog");
    /* The row re-renders when its last-docs line loads (R-2728) — a click can be lost; retry until the dialog opens. */
    await expect(async () => {
      if (!(await dlg.isVisible())) await button.click({ timeout: 5_000 });
      await expect(dlg).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    const create = dlg.getByRole("button", { name: /^Create proforma$/ });
    await expect(create).toBeEnabled({ timeout: 60_000 });
    await create.click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /only when it is paid/ })).toHaveCount(1, { timeout: 60_000 });

    const s = subState(SUB_A);
    expect(s.old, `renewal_date ${s.date} must still be the old date`).toBe(true);
    expect(s.state).toBe("notice_sent");
    expect(proformaOf(SUB_A).id).toMatch(/^PI-/);

    const again = await rowOf(page, "overdue", PLAN_A);
    await expect(again).toHaveCount(1, { timeout: 60_000 });
    await expect(again).toContainText("Renewal quote sent");
    await page.context().close();
  });

  test("Step 2: record the payment → renewal date moves one term, status renewed; the row leaves Overdue", async ({ browser, baseURL }) => {
    const pi = proformaOf(SUB_A);
    pay(pi.id, pi.amount, "CT-R2735-A1");
    const s = subState(SUB_A);
    expect(s.renewedTo, `renewal_date ${s.date} must be one term on`).toBe(true);
    expect(s.state).toBe("renewed");
    const page = await pageAs(browser, baseURL, "owner");
    await expect(await rowOf(page, "overdue", PLAN_A)).toHaveCount(0, { timeout: 60_000 });
    await page.context().close();
  });

  test("Step 3: pay twice (a webhook retry / second receipt) → no second move", async () => {
    const pi = proformaOf(SUB_A);
    pay(pi.id, pi.amount, "CT-R2735-A2");
    const s = subState(SUB_A);
    expect(s.renewedTo, `renewal_date ${s.date} must still be one term on (not two)`).toBe(true);
  });

  test("Step 4: cancel the part proforma → nothing moved", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const billed = await page.request.post(`/api/subscriptions/${SUB_B}/generate-renewal-quote`, { data: { periods: 1 } });
    expect(billed.status(), await billed.text()).toBe(200);
    const pi = proformaOf(SUB_B);
    const cancelled = await page.request.post(`/api/quotes/${pi.id}/cancel`, { data: { reason: "R-2735 card test — customer did not renew" } });
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    const s = subState(SUB_B);
    expect(s.old, `renewal_date ${s.date} must still be the old date`).toBe(true);
    expect(s.state).toBe("notice_sent");
    await page.context().close();
  });
});
