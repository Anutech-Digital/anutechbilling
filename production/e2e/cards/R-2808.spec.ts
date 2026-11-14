/**
 * Card test — R-2808 (R-2805, Pratik — ITBUZZ: Business Standard + Business Starter were on ONE bill last
 * cycle, Renewals showed two "Bill next part" buttons). "Bill together" on Renewals: the two subscriptions
 * show as one group, BOTH TICKED by default (Pardeep 14 Nov: "un subscription ko group me selected by
 * default dikhao"); the dialog lists a line per subscription; Create makes ONE proforma; paid → both
 * renewed with ONE invoice; cancelled → both back.
 *
 * NEEDS THE BACKEND: R-2807 (/api/renewals/bill-together) + R-2810 (bill_parts_together) + R-2806. Until
 * that route answers, every step SKIPS itself (GET → 404) — it runs on its own once they land.
 * Run: `node scripts/ops/card-tests.mjs R-2808`.
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2808 Itbuzz
 * Pvt Ltd with two MONTHLY subscriptions on different (no) sale quotes whose term ended 5 days ago; last
 * month's parts of both were on ONE paid invoice INV-CT2808-PREV:
 *   · A "CT R2808 Business Standard" 161 seats · B "CT R2808 Business Starter" 49 seats.
 * A payment is planted as the payment row every path (Record payment, bank reconcile, Razorpay) writes.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2808000-0000-4000-8000-000000000001";
const SUB_A = "c2808000-0000-4000-8000-000000000021";
const SUB_B = "c2808000-0000-4000-8000-000000000022";
const BILL_A0 = "c2808000-0000-4000-8000-000000000031";
const BILL_B0 = "c2808000-0000-4000-8000-000000000032";
const NAME = "CT R2808 Itbuzz Pvt Ltd";
const PLAN_A = "CT R2808 Business Standard";
const PLAN_B = "CT R2808 Business Starter";
const PREV_INV = "INV-CT2808-PREV";
const db = () => localDb("R-2808");
const T = E2E_TENANT_SQL;
const SUBS = `('${SUB_A}', '${SUB_B}')`;
const OLD_RENEWAL = "(public.ist_today() - 5)";
const API = "/api/renewals/bill-together";

function clean(): void {
  const parts = `(select b.id from public.subscription_billings b where b.subscription_id in ${SUBS})`;
  const reqs = `(select q.id from public.quotes q where q.subscription_billing_id in ${parts} or q.cancelled_part_billing_id in ${parts}
                  or exists (select 1 from jsonb_array_elements(coalesce(q.line_items, '[]'::jsonb)) l where l->>'subscription_id' in ('${SUB_A}', '${SUB_B}')))`;
  const invoiceIds = db().psql(`select distinct b.invoice_id from public.subscription_billings b where b.subscription_id in ${SUBS} and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2808", {
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
      values ('${CUST}', ${T}, '${NAME}', 'ct2808@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'google', 161, 255185, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2808-itbuzz.test'),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'google', 49, 22050, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, ${OLD_RENEWAL}, 'active', 'notice_sent', true, 'ct2808-itbuzz.test');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('${PREV_INV}', ${T}, '${CUST}', '${NAME}', null, 'paid', 327137.3, 49902.3, 327137.3, public.ist_today() - 35, public.ist_today() - 30);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
      values ('${BILL_A0}', ${T}, '${SUB_A}', ((public.ist_today() - 4) - interval '12 months')::date, 11, public.ist_today() - 35,
              public.ist_today() - 35, public.ist_today() - 4, 255185, 18, '${PREV_INV}'),
             ('${BILL_B0}', ${T}, '${SUB_B}', ((public.ist_today() - 4) - interval '12 months')::date, 11, public.ist_today() - 35,
              public.ist_today() - 35, public.ist_today() - 4, 22050, 18, '${PREV_INV}');
    commit;`);
}

function subState(id: string): { date: string; state: string; old: boolean } {
  const [date, state, old] = db().one(
    `select s.renewal_date::text || '|' || s.renewal_state::text || '|' || (s.renewal_date = ${OLD_RENEWAL})::text
       from public.subscriptions s where s.id = '${id}'`).split("|");
  return { date, state, old: old === "true" };
}

/** Live (not cancelled) proformas naming either subscription on a line: id · amount · line count. */
function liveTogether(): Array<{ id: string; amount: number; lines: number }> {
  return db().psql(
    `select q.id || '|' || q.amount || '|' || jsonb_array_length(q.line_items) from public.quotes q
      where q.tenant_id = ${T} and q.cancelled_at is null and q.status not in ('cancelled', 'void')
        and exists (select 1 from jsonb_array_elements(coalesce(q.line_items, '[]'::jsonb)) l where l->>'subscription_id' in ('${SUB_A}', '${SUB_B}'))
      order by q.created_at desc`,
  ).map((r) => { const [id, amount, lines] = r.split("|"); return { id, amount: Number(amount), lines: Number(lines) }; });
}

function pay(quoteId: string, amount: number, ref: string): void {
  db().psql(`insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
             values (${T}, '${quoteId}', ${amount}, 'bank_transfer', '${ref}', 'received', now());`);
}

/** The backend (R-2807/R-2810) is not on this server yet → skip (it runs once they land). */
async function needsBackend(page: Page): Promise<void> {
  const probe = await page.request.get(API, { timeout: 120_000 });
  test.skip(probe.status() === 404, "R-2807 /api/renewals/bill-together not landed yet — runs once R-2807 + R-2810 are merged");
}

async function openOverdue(page: Page): Promise<void> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  await expect(page.locator("tr", { hasText: PLAN_A }).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
}

test.describe("R-2808 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Overdue shows ONE Bill together group ('Billed together last time') with BOTH subscriptions ticked; each row says 'Bills with <other plan>'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await needsBackend(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openOverdue(page);
    const group = page.getByTestId("bill-together-group").filter({ hasText: NAME });
    await expect(group).toHaveCount(1, { timeout: 60_000 });
    await expect(group.getByTestId("bill-together-why")).toHaveText("Billed together last time");
    await expect(group.getByRole("checkbox", { name: new RegExp(PLAN_A) })).toBeChecked();
    await expect(group.getByRole("checkbox", { name: new RegExp(PLAN_B) })).toBeChecked();
    await expect(page.locator("tr", { hasText: PLAN_A }).getByTestId("renewal-bills-with")).toHaveText(`Bills with ${PLAN_B}`);
    await expect(page.locator("tr", { hasText: PLAN_B }).getByTestId("renewal-bills-with")).toHaveText(`Bills with ${PLAN_A}`);
    /* still fits 1280 / 1276 (R-2759) */
    for (const w of [1280, 1276]) {
      await page.setViewportSize({ width: w, height: 800 });
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(m.scroll, `no horizontal scroll at ${w}`).toBeLessThanOrEqual(m.inner);
    }
    await page.context().close();
  });

  test("Step 2: Bill together → dialog with 2 ticked lines + total; untick drops a line; Create → ONE proforma with 2 lines", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    const page = await pageAs(browser, baseURL, "owner");
    await needsBackend(page);
    await openOverdue(page);
    await page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
    await expect(dlg.getByRole("checkbox", { name: PLAN_A })).toBeChecked();
    await expect(dlg.getByRole("checkbox", { name: PLAN_B })).toBeChecked();
    await expect(dlg.getByTestId("bill-together-total")).toContainText("Total (2 lines)");
    await dlg.getByRole("checkbox", { name: PLAN_B }).click();
    await expect(dlg.getByTestId("bill-together-total")).toContainText("Total (1 line)");
    await expect(dlg.getByRole("button", { name: "Create proforma" })).toBeDisabled();
    await dlg.getByRole("checkbox", { name: PLAN_B }).click();
    await dlg.getByRole("button", { name: "Create proforma" }).click();
    await expect(page).toHaveURL(/\/quotes\/PI-/, { timeout: 120_000 });
    const live = liveTogether();
    expect(live, "ONE live proforma for both").toHaveLength(1);
    expect(live[0].lines).toBe(2);
    expect(subState(SUB_A).old && subState(SUB_B).old, "no date moves before payment (R-2735)").toBe(true);
    await page.context().close();
  });

  test("Step 3: both rows show that proforma; a single row's Bill next part says it is already billed together and links it", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await needsBackend(page);
    const pi = liveTogether()[0];
    await openOverdue(page);
    for (const plan of [PLAN_A, PLAN_B]) {
      await expect(page.locator("tr", { hasText: plan }).getByTestId("stage-chip")).toContainText("Quote sent", { timeout: 60_000 });
    }
    const resp = await page.request.get(`${API}?ids=${SUB_B}`);
    const body = await resp.json();
    expect(body.subs[0].onTogetherBill?.quoteId).toBe(pi.id);
    /* the owner's path: B's ⋯ → Bill next part → the dialog names the together proforma, links it, no Create */
    const rowB = page.locator("tr", { hasText: PLAN_B }).filter({ visible: true });
    const dlg = page.getByRole("dialog");
    await expect(async () => {
      if (!(await page.getByRole("menuitem", { name: /Bill next part/ }).isVisible())) await rowB.getByTestId("stage-more").click({ timeout: 5_000 });
      await page.getByRole("menuitem", { name: /Bill next part/ }).click({ timeout: 5_000 });
      await expect(dlg).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await expect(dlg.getByTestId("bill-next-on-together")).toContainText(`Already billed together on ${pi.id} with ${PLAN_A}`, { timeout: 150_000 });
    await expect(dlg.getByRole("link", { name: "Open it" })).toHaveAttribute("href", `/quotes/${pi.id}`);
    await expect(dlg.getByRole("button", { name: "Create proforma" })).toBeDisabled();
    await page.context().close();
  });

  test("Step 4: cancel the together proforma → both back (no live proforma, dates unchanged)", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await needsBackend(page);
    const pi = liveTogether()[0];
    const cancelled = await page.request.post(`/api/quotes/${pi.id}/cancel`, { data: { reason: "R-2808 card test — bill separately" }, timeout: 180_000 });
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    expect(liveTogether()).toHaveLength(0);
    expect(subState(SUB_A).old && subState(SUB_B).old).toBe(true);
    await page.context().close();
  });

  test("Step 5: bill together again and pay it → both renewed, ONE new invoice", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await needsBackend(page);
    const made = await page.request.post(API, { data: { ids: [SUB_A, SUB_B] }, timeout: 180_000 });
    expect(made.status(), await made.text()).toBe(200);
    const pi = liveTogether()[0];
    expect(pi.lines).toBe(2);
    pay(pi.id, pi.amount, "CT-R2808-1");
    expect(subState(SUB_A).old, "A renewed").toBe(false);
    expect(subState(SUB_B).old, "B renewed").toBe(false);
    const invoices = db().psql(`select distinct b.invoice_id from public.subscription_billings b
                                 where b.subscription_id in ${SUBS} and b.invoice_id is not null and b.invoice_id <> '${PREV_INV}'`);
    expect(invoices, "ONE invoice for both parts").toHaveLength(1);
    await page.context().close();
  });
});
