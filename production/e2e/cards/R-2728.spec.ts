/**
 * Card test — R-2728 "Renewals list: show the last quote and invoice sent (clickable); after
 * 'Review renewal quote' / 'Bill next part' the row stays, shown under 'Renewal quote sent' with
 * 'expires in N days'" (Pardeep for Pratik, 13 Nov).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2728`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   CT R2728 Renewals Pvt Ltd with
 *   · A "CT R2728 Workspace" — yearly, renewal date 5 days ago; its renewal quote Q-CT2728-REN was
 *     SENT 2 days ago, valid 10 more days, unpaid; the original sale Q-CT2728-ORIG has the paid
 *     invoice INV-CT2728-1;
 *   · B "CT R2728 Parts Plan" — annual paid half-yearly, in the state "Bill next part" leaves it:
 *     renewal date rolled a year on, renewal_state 'renewed', part 1 of the new term raised as the
 *     proforma PI-CT2728-1 (sent, unpaid, no expiry date) — the real click is R-2548 / R-2519's;
 *   · C "CT R2728 Unsent Plan" — yearly, renewal date 5 days ago, nothing sent.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2728000-0000-4000-8000-000000000001";
const SUB_A = "c2728000-0000-4000-8000-000000000021";
const SUB_B = "c2728000-0000-4000-8000-000000000022";
const SUB_C = "c2728000-0000-4000-8000-000000000023";
const BILL_B = "c2728000-0000-4000-8000-000000000031";
const NAME = "CT R2728 Renewals Pvt Ltd";
const db = () => localDb("R-2728");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2728", {
    invoiceIds: ["INV-CT2728-1"],
    before: `update public.quotes set invoice_id = null where id in ('Q-CT2728-ORIG') and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in ('${SUB_A}', '${SUB_B}', '${SUB_C}') and tenant_id = ${T};`,
    after: `delete from public.quotes where id in ('Q-CT2728-ORIG', 'Q-CT2728-REN', 'PI-CT2728-1') and tenant_id = ${T};
            delete from public.subscription_billings where id = '${BILL_B}' and tenant_id = ${T};
            delete from public.subscriptions where id in ('${SUB_A}', '${SUB_B}', '${SUB_C}') and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2728@example.test', '07', 'India');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2728-ORIG', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 370, 14160, 12000, 18, '[]');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, quote_id)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', 'CT R2728 Workspace', 'google', 10, 1000, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 'Q-CT2728-ORIG'),
             ('${SUB_C}', ${T}, '${CUST}', '${NAME}', 'CT R2728 Unsent Plan', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, null),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', 'CT R2728 Parts Plan', 'microsoft', 5, 500, 12, 'half_yearly',
              public.ist_today() - 370, public.ist_today() + 360, 'active', 'renewed', true, null);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               created_date, expires_date, amount, subtotal, tax_rate, line_items, notes)
      values ('Q-CT2728-REN', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB_A}',
              public.ist_today() - 2, public.ist_today() + 10, 14160, 12000, 18, '[]', 'Renewal for subscription ${SUB_A}');
    update public.subscriptions set renewal_quote_id = 'Q-CT2728-REN' where id = '${SUB_A}';
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2728-1', ${T}, '${CUST}', '${NAME}', 'Q-CT2728-ORIG', 'paid', 14160, 2160, 14160, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2728-1' where id = 'Q-CT2728-ORIG';
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL_B}', ${T}, '${SUB_B}', public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 177, 3000, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('PI-CT2728-1', ${T}, '${CUST}', '${NAME}', 'sent', 'awaiting', '${BILL_B}', public.ist_today() - 4, 3540, 3000, 18, '[]');
    commit;`);
}

/** The visible table row of one planted plan on a tab. */
async function rowOf(page: Page, bucket: string, plan: string) {
  await openAppPage(page, `/renewals?bucket=${bucket}`, /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2728 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: a row whose renewal quote was sent stays (Overdue tab): status 'Renewal quote sent', 'Overdue 5d', 'Expires in 10 days', quote number clickable, last invoice clickable", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "overdue", "CT R2728 Workspace");
    /* R-2760 (R-2758/R-2759 table): ONE chip "Quote sent" that opens the quote; its day count under it; the
       quote's validity in the Due column; the last invoice in its own column */
    const chip = r.getByTestId("stage-chip");
    await expect(chip).toContainText("Quote sent", { timeout: 60_000 });
    await expect(r.getByTestId("stage-primary")).toBeEnabled({ timeout: 60_000 });   // the role is read (the chip link depends on it)
    await expect(r.getByTestId("stage-line2")).toContainText("Overdue 5d");
    await expect(r.getByTestId("stage-chip-quote")).toHaveAttribute("href", "/quotes/Q-CT2728-REN");
    await expect(r.getByTestId("due-quote-expiry")).toHaveText("exp. in 10d");
    await expect(r.getByTestId("due-quote-expiry")).toHaveAttribute("title", "Expires in 10 days");
    const inv = await onlyOne(r.getByTestId("renewal-last-invoice-cell"), "last invoice cell");
    await expect(await onlyOne(inv.getByRole("link", { name: "INV-CT2728-1" }), "invoice link")).toHaveAttribute("href", "/invoices/INV-CT2728-1");
    await expect(inv).toContainText("Paid");
    /* the sent quote's row: one button (Follow up) — never a second Send / Review; Change renewal is in ⋯ */
    await expect(r.getByTestId("stage-primary")).toHaveText(/Follow up/);
    await expect(r.getByRole("button", { name: /Review renewal quote|Send renewal/ })).toHaveCount(0);
  });

  test("Step 2: the 'Bill next part' row shows its part proforma clickable and stays as 'Renewal quote sent' (not 'Renewed'), 'No expiry set'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "later", "CT R2728 Parts Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Quote sent", { timeout: 60_000 });
    await expect(r.getByTestId("stage-primary")).toBeEnabled({ timeout: 60_000 });
    await expect(r.getByText("Renewed", { exact: true })).toHaveCount(0);
    await expect(r.getByTestId("due-quote-expiry")).toHaveText("no expiry");
    /* due on the part's own date (5 days ago), not the renewal date a year out */
    await expect(r.getByTestId("stage-line2")).toContainText("Overdue 5d");
    await expect(r.getByTestId("stage-chip-quote")).toHaveAttribute("href", "/quotes/PI-CT2728-1");
  });

  test("Step 3: status filter 'Quote sent (N)' (R-2760: the stage) lists exactly those rows; the unsent overdue row is not in it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await rowOf(page, "overdue", "CT R2728 Unsent Plan");
    const filter = page.getByRole("combobox", { name: "Filter by status" });
    const option = filter.locator("option", { hasText: /^Quote sent \(\d+\)$/ });
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await filter.selectOption("sent");
    const table = page.locator("table").filter({ visible: true });
    await expect(table.locator("tr", { hasText: "CT R2728 Workspace" })).toHaveCount(1, { timeout: 30_000 });
    await expect(table.locator("tr", { hasText: "CT R2728 Unsent Plan" })).toHaveCount(0);
    /* every row the filter shows says the same status */
    const rows = table.locator("tbody tr");
    const n = await rows.count();
    for (let i = 0; i < n; i++) await expect(rows.nth(i).getByTestId("stage-chip")).toContainText("Quote sent");
  });

  test("Step 4: counts still add up — the Overdue tile counts the sent row once, and the sent row is on one tab only", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const tabs = ["overdue", "due7", "d30", "d60", "d90", "later"];
    let seen = 0;
    for (const t of tabs) {
      await openAppPage(page, `/renewals?bucket=${t}`, /Renewals/);
      await expect(page.locator("table").filter({ visible: true }).or(page.getByText(/No subscriptions in this window|No renewals in this window/))).toBeVisible({ timeout: 60_000 });
      seen += await page.locator("tr", { hasText: "CT R2728 Workspace" }).filter({ visible: true }).count();
    }
    expect(seen).toBe(1);
    /* the Overdue tile lists the row once (tile view = every tab's rows that the tile adds up) */
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const tiles = page.getByRole("group", { name: /Renewal totals/ });
    await (await onlyOne(tiles.getByRole("button", { name: /^Overdue/ }), "Overdue tile")).click();
    await expect(page.locator("tr", { hasText: "CT R2728 Workspace" }).filter({ visible: true })).toHaveCount(1, { timeout: 30_000 });
  });

  test("Step 5: ⋯ on the sent row offers 'Record payment' → the quote's Record payment (/quotes/<id>?pay=1)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "overdue", "CT R2728 Workspace");
    const more = r.getByRole("button", { name: /More renewal actions for/ });
    await expect(more).toBeVisible({ timeout: 60_000 });
    await expect(r.getByTestId("stage-primary")).toBeEnabled({ timeout: 60_000 });
    const item = page.getByRole("menuitem", { name: "Record payment" });
    /* a click on a busy dev server can land before the menu is wired — open it until the item shows */
    await expect(async () => {
      if (!(await item.isVisible())) await more.click();
      await expect(item).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole("menuitem", { name: /^Resend$/ })).toBeVisible();
    await item.click();
    await expect(page).toHaveURL(/\/quotes\/Q-CT2728-REN(\?pay=1)?$/, { timeout: 120_000 });
  });
});
