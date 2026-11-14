/**
 * Card test — R-2752 "Renewals row: paid facts must agree" (user audit 14 Nov 2026: Greentin
 * 'never paid' next to 'Invoice … · Paid'; SCN Ads 'Previous term ₹98 still unpaid' next to a Paid
 * invoice; SCN Kochi ₹25,488 with no invoice while the customer page says All clear).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2752`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2752 Renewals Pvt Ltd", renewal dates 5 days ago (Overdue tab):
 *   · P "CT R2752 Part Paid Plan" — a billed part invoiced as INV-CT2752-P (Paid); the ₹3,835 UPI
 *     receipt was recorded on the part's proforma PI-CT2752-1 (as Greentin Behind's was);
 *   · N "CT R2752 No Receipt Plan" — INV-CT2752-N marked Paid, no receipt in the app;
 *   · B "CT R2752 Balance Plan" — ₹98 on the subscription, its invoice INV-CT2752-B Paid (as SCN Ads).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2752000-0000-4000-8000-000000000001";
const SUB_P = "c2752000-0000-4000-8000-000000000021";
const SUB_N = "c2752000-0000-4000-8000-000000000022";
const SUB_B = "c2752000-0000-4000-8000-000000000023";
const SUBS = [SUB_P, SUB_N, SUB_B];
const BILL_P = "c2752000-0000-4000-8000-000000000031";
const PAY_P = "c2752000-0000-4000-8000-000000000041";
const PAY_B = "c2752000-0000-4000-8000-000000000042";
const NAME = "CT R2752 Renewals Pvt Ltd";
const QUOTES = ["PI-CT2752-1", "Q-CT2752-N", "Q-CT2752-B"];
const INVOICES = ["INV-CT2752-P", "INV-CT2752-N", "INV-CT2752-B"];
const db = () => localDb("R-2765");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2752", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id in ('${PAY_P}', '${PAY_B}') and tenant_id = ${T};
             update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id = '${BILL_P}' and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscription_billings where id = '${BILL_P}' and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2752@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB_P}', ${T}, '${CUST}', '${NAME}', 'CT R2752 Part Paid Plan', 'google', 10, 325, 12, 'quarterly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0),
             ('${SUB_N}', ${T}, '${CUST}', '${NAME}', 'CT R2752 No Receipt Plan', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', 'CT R2752 Balance Plan', 'google', 1, 100, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 98);
    -- P: a billed part; its proforma took the UPI receipt; the part invoice is Paid
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL_P}', ${T}, '${SUB_P}', public.ist_today() - 370, 1, public.ist_today() - 40, public.ist_today() - 40, public.ist_today() - 10, 3250, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('PI-CT2752-1', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', '${BILL_P}', public.ist_today() - 40, 3835, 3250, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2752-P', ${T}, '${CUST}', '${NAME}', null, 'paid', 3835, 585, 3835, public.ist_today() - 38);
    update public.subscription_billings set invoice_id = 'INV-CT2752-P' where id = '${BILL_P}';
    update public.quotes set invoice_id = 'INV-CT2752-P' where id = 'PI-CT2752-1';
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY_P}', ${T}, 'PI-CT2752-1', '${CUST}', 3835, 'upi', 'CTUPI2752', 'received', now() - interval '38 days', 'Card test R-2752 — local only');
    -- N: invoice marked Paid, no receipt recorded in the app
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2752-N', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, 2360, 2000, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2752-N', ${T}, '${CUST}', '${NAME}', 'Q-CT2752-N', 'paid', 2360, 360, 2360, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2752-N' where id = 'Q-CT2752-N';
    update public.subscriptions set quote_id = 'Q-CT2752-N' where id = '${SUB_N}';
    -- B: ₹98 on the subscription only; its invoice paid with a receipt
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2752-B', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', public.ist_today() - 371, 1180, 1000, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2752-B', ${T}, '${CUST}', '${NAME}', 'Q-CT2752-B', 'paid', 1180, 180, 1180, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2752-B' where id = 'Q-CT2752-B';
    update public.subscriptions set quote_id = 'Q-CT2752-B' where id = '${SUB_B}';
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY_B}', ${T}, 'Q-CT2752-B', '${CUST}', 1180, 'upi', 'CTUPI2752B', 'received', now() - interval '360 days', 'Card test R-2752 — local only');
    update public.subscriptions set outstanding_amount = 98 where id = '${SUB_B}';
    commit;`);
}

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const r = page.getByTestId("renewals-cards").locator("li", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2765 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: a receipt on the billed part's proforma is Last paid — never 'never paid' next to 'Invoice … · Paid'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 900, height: 900 });
    const r = await rowOf(page, "CT R2752 Part Paid Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(docs.locator("[data-invoice-id='INV-CT2752-P']").getByTestId("renewal-last-invoice-status")).toHaveText("Paid", { timeout: 60_000 });
    await expect(r.getByText(/never paid in the app/)).toHaveCount(0);
    await expect(r.getByText("Last paid", { exact: false }).first()).toBeVisible();
    await expect(r).toContainText("₹3,835 · UPI");
  });

  test("Step 1b: an invoice marked Paid with no receipt reads 'Paid, no receipt in the app'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 900, height: 900 });
    const r = await rowOf(page, "CT R2752 No Receipt Plan");
    const line = await onlyOne(r.getByTestId("renewal-last-paid-no-receipt"), "paid-no-receipt line");
    await expect(line).toHaveText("Last paid INV-CT2752-N — Paid, no receipt in the app", { timeout: 60_000 });
    await expect(r.getByText(/never paid in the app/)).toHaveCount(0);
  });

  test("Step 2: ₹98 on the subscription next to a Paid invoice says where it is ('no unpaid invoice linked to it')", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 900, height: 900 });
    const r = await rowOf(page, "CT R2752 Balance Plan");
    /* since R-2758 the previous-term balance is the stage chip's flag icon (its label says it) */
    await expect(r.locator("[data-flag='priorTermUnpaid']")).toHaveAttribute("aria-label", /₹98/, { timeout: 60_000 });
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(docs.getByTestId("renewal-prior-due-no-invoice")).toHaveText("Balance on the subscription — no unpaid invoice linked to it");
    await expect(docs.locator("[data-invoice-id='INV-CT2752-B']").getByTestId("renewal-last-invoice-status")).toHaveText("Paid");
  });
});
