/**
 * Card test — R-2922 "A month-wise (part) renewal request is built like a normal renewal quotation"
 * (Pardeep, 18 Nov 2026 — staging Q-A378-27-0124: "ye renewal quotation ki tarah jaye").
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login, at a 1280 laptop.
 * Run: `node scripts/ops/card-tests.mjs R-2922` (R2922_KEEP=1 leaves the rows in place to look at by hand).
 * Needs migration 20261118152019_r2922_part_request_like_renewal on the local DB (npm run localhost:update).
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): the catalogue item
 * "CT R2922 Workspace Starter" (₹450 a seat a month, our cost ₹300) and the customer "CT R2922 Monthly Co" with
 * one subscription of it — 7 seats, annual term billed MONTHLY — whose term ended 5 days ago, nothing billed.
 * The next part is billed through the Renewals row's own route (Bill next part). Nothing is sent to anyone;
 * the payment is planted as the payment row every path (Record payment, bank reconcile, Razorpay) writes.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2922000-0000-4000-8000-000000000001";
const SUB = "c2922000-0000-4000-8000-000000000021";
const NAME = "CT R2922 Monthly Co";
const PLAN = "CT R2922 Workspace Starter";
const ITEM = "CT-R2922-STR";
const SEATS = 7;
const RATE = 450;
const COST = 300;
const db = () => localDb("R-2922");
const T = E2E_TENANT_SQL;

function clean(): void {
  const parts = `(select b.id from public.subscription_billings b where b.subscription_id = '${SUB}')`;
  const reqs = `(select q.id from public.quotes q where q.subscription_billing_id in ${parts} or q.cancelled_part_billing_id in ${parts})`;
  const invoiceIds = db().psql(`select b.invoice_id from public.subscription_billings b where b.subscription_id = '${SUB}' and b.invoice_id is not null`);
  localCleanupDeleteIssuedInvoice(db(), "R-2922", {
    invoiceIds: invoiceIds.length ? invoiceIds : ["INV-CT2922-NONE"],
    before: `delete from public.tds_receivable where payment_id in (select p.id from public.payments p where p.quote_id in ${reqs});
             delete from public.payments where quote_id in ${reqs} and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where subscription_id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id in ${reqs} and tenant_id = ${T};`,
    after: `delete from public.quotes where id in ${reqs} and tenant_id = ${T};
            delete from public.subscription_billings where subscription_id = '${SUB}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};
            delete from public.items where id = '${ITEM}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type)
      values ('${ITEM}', ${T}, '${PLAN}', 'google', ${RATE}, ${COST},
              '{"annual":{"msrp":${RATE},"wholesale":${COST}}}'::jsonb, 'subscription');
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2922@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, item_id, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', '${ITEM}', 'google', ${SEATS}, ${SEATS * RATE}, 12, 'monthly',
              ((public.ist_today() - 4) - interval '12 months')::date, public.ist_today() - 5, 'active', 'notice_sent', true,
              'ct2922.example.test');
    commit;`);
}

/** The subscription's newest live part request: id | amount | subtotal | total_cost | is_renewal | its first line. */
function proforma(): { id: string; amount: number; subtotal: number; totalCost: number; isRenewal: boolean; line: Record<string, unknown>; lines: number } {
  const [id, amount, subtotal, totalCost, isRenewal, lines, ...lineJson] = db().one(
    `select q.id || '|' || q.amount || '|' || q.subtotal || '|' || q.total_cost || '|' || coalesce(q.is_renewal, false)::text
            || '|' || jsonb_array_length(q.line_items) || '|' || (q.line_items->0)::text
       from public.quotes q join public.subscription_billings b on b.id = q.subscription_billing_id
      where b.subscription_id = '${SUB}' and q.cancelled_at is null order by q.created_at desc limit 1`).split("|");
  return { id, amount: Number(amount), subtotal: Number(subtotal), totalCost: Number(totalCost), isRenewal: isRenewal === "true",
           lines: Number(lines), line: JSON.parse(lineJson.join("|")) as Record<string, unknown> };
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const row = (page: Page) => page.locator("tr", { hasText: PLAN }).filter({ visible: true });

async function openOverdue(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  /* a busy laptop's local Supabase sometimes drops a read ("couldn't load") — reload (up to 3 tries) rather than judge a failed read */
  for (let attempt = 1; ; attempt++) {
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(row(page)).toHaveCount(1, { timeout: 90_000 });
    await expect(table.getByTestId("renewal-row-quote").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    if (!(await table.getByText(/couldn.t load/).count())) return;
    if (attempt >= 3) throw new Error(`a row read failed ${attempt}x on this server (local Supabase load)`);
  }
}

test.describe("R-2922 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 480_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON && process.env.R2922_KEEP !== "1") clean(); });

  test("Step 1: Renewals → Bill next part on a month-wise subscription → the request's line is the catalogue product: seats × rate a seat, with our cost", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    /* the Renewals row's own "Bill next part" route (one period, the subscription's own seats) */
    const billed = await page.request.post(`/api/subscriptions/${SUB}/generate-renewal-quote`, { data: { periods: 1 }, timeout: 180_000 });
    expect(billed.status(), await billed.text()).toBe(200);
    const pi = proforma();
    expect(pi.id).toMatch(/^PI-/);
    expect(pi.lines).toBe(1);
    expect(pi.subtotal, "amount unchanged: seats × the rate a seat").toBe(SEATS * RATE);
    expect(pi.line.item_id, "the line names the subscription's catalogue item").toBe(ITEM);
    expect(pi.line.qty).toBe(SEATS);
    expect(pi.line.rate).toBe(RATE);
    expect(pi.line.per_seat).toBe(true);
    expect(pi.line.cost, "our cost a seat for the month, from the catalogue").toBe(COST);
    expect(pi.totalCost).toBe(SEATS * COST);
    expect(pi.line.one_time, "still a part line — it never files a subscription").toBe(true);
    expect(String(pi.line.name)).toContain(PLAN);
    expect(String(pi.line.description)).toMatch(/^Payment for month 1 · /);
    expect(pi.isRenewal, "not flagged a whole-term renewal quote").toBe(false);
    await page.context().close();
  });

  test("Step 2: the row's quote number opens the pop-up — TYPE Renewal · Part 1 of 12, the product line with its rate a seat, totals", async ({ browser, baseURL }) => {
    const pi = proforma();
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const line = await onlyOne(row(page).getByTestId("renewal-row-quote"), "the row's quote line");
    const link = line.getByRole("link", { name: pi.id });
    await expect(link).toBeVisible({ timeout: 90_000 });
    await link.click();
    const dlg = page.getByRole("dialog", { name: `Quote ${pi.id}` });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await expect(dlg).toContainText(NAME);
    await expect(dlg.getByTestId("quote-peek-type")).toHaveText(/^Renewal · Part 1 of 12 · /, { timeout: 60_000 });
    await expect(dlg.getByTestId("quote-peek-line")).toHaveCount(1, { timeout: 60_000 });
    await expect(dlg.getByTestId("quote-peek-lines")).toContainText(PLAN);
    await expect(dlg.getByTestId("quote-peek-lines")).toContainText(`${SEATS} seats`);
    await expect(dlg.getByTestId("quote-peek-lines")).not.toContainText("Payment for month");
    /* the name already says the seats and the period — the pop-up adds the rate a seat */
    await expect(dlg.getByTestId("quote-peek-line-detail")).toHaveText(`${inr(RATE)} a seat`);
    await expect(dlg.getByTestId("quote-peek-total")).toHaveText(inr(pi.amount));
    await expect(dlg.getByRole("button", { name: "Record payment" })).toBeVisible({ timeout: 60_000 });
    await page.context().close();
  });

  test("Step 3: the request is paid → that month's tax invoice of the same amount; no new subscription is filed", async () => {
    const pi = proforma();
    db().psql(`insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
               values (${T}, '${pi.id}', ${pi.amount}, 'bank_transfer', 'CT-R2922-1', 'received', now());`);
    const [invoiceId, invoiceAmount, invoiceStatus, quoteInvoice, subs] = db().one(
      `select coalesce(b.invoice_id, '') || '|' || coalesce(i.amount::text, '') || '|' || coalesce(i.status::text, '') || '|' || coalesce(q.invoice_id, '')
              || '|' || (select count(*) from public.subscriptions s where s.customer_id = '${CUST}')
         from public.quotes q
         join public.subscription_billings b on b.id = q.subscription_billing_id
         left join public.invoices i on i.id = b.invoice_id
        where q.id = '${pi.id}'`).split("|");
    expect(invoiceId, "the part has its tax invoice").not.toBe("");
    expect(quoteInvoice, "the request points at that invoice").toBe(invoiceId);
    expect(Number(invoiceAmount), "the invoice bills what the request asked").toBe(pi.amount);
    expect(invoiceStatus).toBe("paid");
    expect(Number(subs), "paying a part request files no subscription").toBe(1);
  });
});
