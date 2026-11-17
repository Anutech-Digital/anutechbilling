/**
 * Card test — R-2841 "Renewals history H6: table row shows a newer quote the Status chip doesn't name".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2841`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2841 Renewals Pvt Ltd", renewal dates 5 days ago (Overdue tab), both last billed by a
 * Paid invoice a year ago:
 *   · S "CT R2841 Seats Plan" — an add-seats quote Q-CT2841-S accepted 2 days ago, not invoiced
 *     → the row shows "Quote Q-CT2841-S · Accepted" under the Paid invoice;
 *   · R "CT R2841 Sent Plan"  — its renewal quote Q-CT2841-R sent yesterday → the chip says
 *     "Quote sent" and the Last invoice cell does NOT repeat it.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2841000-0000-4000-8000-000000000001";
const SUB_S = "c2841000-0000-4000-8000-000000000021";
const SUB_R = "c2841000-0000-4000-8000-000000000022";
const SUBS = [SUB_S, SUB_R];
const NAME = "CT R2841 Renewals Pvt Ltd";
const QUOTES = ["Q-CT2841-1", "Q-CT2841-2", "Q-CT2841-S", "Q-CT2841-R"];
const INVOICES = ["INV-CT2841-1", "INV-CT2841-2"];
const db = () => localDb("R-2841");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2841", {
    invoiceIds: INVOICES,
    before: `update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2841@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB_S}', ${T}, '${CUST}', '${NAME}', 'CT R2841 Seats Plan', 'google', 5, 500, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0),
             ('${SUB_R}', ${T}, '${CUST}', '${NAME}', 'CT R2841 Sent Plan', 'google', 3, 300, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0);
    -- last year's sale: accepted quote → Paid invoice (both subscriptions)
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2841-1', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', public.ist_today() - 371, 7080, 6000, 18, '[]'),
             ('Q-CT2841-2', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', public.ist_today() - 371, 4248, 3600, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2841-1', ${T}, '${CUST}', '${NAME}', 'Q-CT2841-1', 'paid', 7080, 1080, 7080, public.ist_today() - 369),
             ('INV-CT2841-2', ${T}, '${CUST}', '${NAME}', 'Q-CT2841-2', 'paid', 4248, 648, 4248, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2841-1' where id = 'Q-CT2841-1';
    update public.quotes set invoice_id = 'INV-CT2841-2' where id = 'Q-CT2841-2';
    update public.subscriptions set quote_id = 'Q-CT2841-1' where id = '${SUB_S}';
    update public.subscriptions set quote_id = 'Q-CT2841-2' where id = '${SUB_R}';
    -- S: an add-seats quote accepted 2 days ago, not invoiced yet
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, add_seats_subscription_id, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2841-S', ${T}, '${CUST}', '${NAME}', 'accepted', 'none', '${SUB_S}', public.ist_today() - 2, public.ist_today() + 28, 1180, 1000, 18, '[]');
    -- R: the renewal quote sent yesterday — the chip names it
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, renewal_subscription_id, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2841-R', ${T}, '${CUST}', '${NAME}', 'sent', 'awaiting', '${SUB_R}', public.ist_today() - 1, public.ist_today() + 29, 4248, 3600, 18, '[]');
    update public.subscriptions set renewal_quote_id = 'Q-CT2841-R' where id = '${SUB_R}';
    commit;`);
}

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2841 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: the Paid invoice shows in the 1280 table's Last bill; the add-seats quote is not repeated there as a quote note", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2841 Seats Plan");
    const cell = await onlyOne(r.getByTestId("renewal-last-invoice-cell"), "last invoice cell");
    /* R-2854: Last bill = the invoice number + the payment line; "Paid" is said once (the payment line "Paid on invoice,
       no receipt" / "Paid ₹… · date") — the separate status line is dropped when it would repeat it (lastBillLines) */
    await expect(cell.getByTestId("renewal-last-invoice-no")).toHaveText("INV-CT2841-1", { timeout: 60_000 });
    await expect(cell.getByTestId("renewal-row-last-paid")).toHaveText(/^Paid/, { timeout: 60_000 });
    /* R-2854 (one fact once): the table's Last bill never names a quote, and the Product column's quote line is THIS
       renewal's quote — this subscription has none ("No renewal quote yet"), so the add-seats quote is not on the row.
       That is a change from R-2841's table promise: see the R-2841 regression step below (filed as R-2877). */
    await expect(cell.getByTestId("renewal-row-quote-note")).toHaveCount(0);
    await expect(r.getByTestId("renewal-row-quote")).toHaveAttribute("data-quote", "none");
    /* fits 1280: the table needs no side scroll */
    const fits = await page.evaluate(() => { const t = document.querySelector("table"); const p = t?.parentElement; return !!p && p.scrollWidth <= p.clientWidth + 1; });
    expect(fits).toBe(true);
  });

  /* R-2841's table promise — an accepted add-seats quote not invoiced yet shows "Quote Q-… · Accepted" on the row — is
     GONE from the table since R-2854 (the row shows only THIS renewal's quote). It still holds in the card layout below
     the table's width (the next step). The table half is a REGRESSION against R-2841: it stays here, unchanged in
     meaning, as test.fixme until the card filed for it (R-2877) puts a rule back or the owner drops it. */
  test.fixme("Step 1b (REGRESSION vs R-2841, table): an accepted add-seats quote not invoiced shows 'Quote Q-CT2841-S · Accepted' on the 1280 table row", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2841 Seats Plan");
    await expect(r.getByText("Q-CT2841-S")).toHaveCount(1, { timeout: 60_000 });
    await expect(r).toContainText("Accepted");
  });

  test("Step 1c: below the table width (cards) the accepted add-seats quote still shows 'Quote Q-CT2841-S · … · Accepted', linked, under the Paid invoice", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1100, height: 900 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const docs = page.getByTestId("renewal-last-docs").filter({ hasText: "Q-CT2841-S" }).filter({ visible: true });
    await expect(docs).toHaveCount(1, { timeout: 60_000 });
    const line = await onlyOne(docs.locator('[data-doc-line="quote"]'), "quote line");
    await expect(line).toContainText("Accepted");
    await expect(line.getByRole("link", { name: "Q-CT2841-S" })).toHaveAttribute("href", "/quotes/Q-CT2841-S");
    await expect(docs.locator('[data-doc-line="invoice"]')).toContainText("INV-CT2841-1");
  });

  test("Step 2: a 'Quote sent' row names its quote ONCE (Product column's quote line), not again under its invoice", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2841 Sent Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Quote sent", { timeout: 60_000 });
    const cell = await onlyOne(r.getByTestId("renewal-last-invoice-cell"), "last invoice cell");
    await expect(cell.getByTestId("renewal-row-last-paid")).toHaveText(/^Paid/);
    await expect(cell.getByTestId("renewal-row-quote-note")).toHaveCount(0);
    await expect(cell.getByText("Q-CT2841-R")).toHaveCount(0);
    /* the quote is named once on the row: the Product column's quote line (the chip's link is the same quote) */
    await expect(r.getByTestId("renewal-row-quote")).toHaveAttribute("data-quote", "Q-CT2841-R");
    await expect(r.getByTestId("renewal-row-quote-number")).toHaveAttribute("href", "/quotes/Q-CT2841-R");
  });
});
