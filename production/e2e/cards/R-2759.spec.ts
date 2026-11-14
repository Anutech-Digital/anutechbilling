/**
 * Card test — R-2759 (R-2739b) "Renewals table fits 1280 (sidebar open) and 1568 with NO horizontal
 * scroll: 2-line rows, Product & period, Due, Amount, Status, Last invoice, Action".
 *
 * A REAL browser width check (jsdom has no layout): at 1280×800 and 1568×900, sidebar open, the page
 * shows the TABLE (not the card list), document.scrollWidth ≤ innerWidth, every Action cell's right
 * edge is inside the viewport, and the seeded rows stay short (two lines a cell).
 * Run: `node scripts/ops/card-tests.mjs R-2759`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): a customer
 * with a very long name and e-mail, renewing in 12 days (tab 8–30):
 *   · L "CT R2759 Google Workspace Business Starter Flexible Plan With A Very Long Name" — nothing sent;
 *   · Q "CT R2759 Quarterly Plan" — billed quarterly, a part invoice overdue (₹23,010);
 *   · S "CT R2759 Sent Plan" — renewal quote Q-CT2759-S sent (chip "Renewal quote sent", amount "incl. GST · Q-…").
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2759000-0000-4000-8000-000000000001";
const SUB_L = "c2759000-0000-4000-8000-000000000021";
const SUB_Q = "c2759000-0000-4000-8000-000000000022";
const SUB_S = "c2759000-0000-4000-8000-000000000023";
const BILL_Q = "c2759000-0000-4000-8000-000000000031";
const NAME = "CT R2759 Very Long Customer Name Infotech Private Limited Bengaluru";
const LONG_PLAN = "CT R2759 Google Workspace Business Starter Flexible Plan With A Very Long Name";
const INVOICES = ["INV-CT2759-Q"];
const db = () => localDb("R-2759");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2759", {
    invoiceIds: INVOICES,
    before: `update public.subscription_billings set invoice_id = null where id = '${BILL_Q}' and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null where id = '${SUB_S}' and tenant_id = ${T};`,
    after: `delete from public.subscription_billings where id = '${BILL_Q}' and tenant_id = ${T};
            delete from public.quotes where id = 'Q-CT2759-S' and tenant_id = ${T};
            delete from public.subscriptions where id in ('${SUB_L}', '${SUB_Q}', '${SUB_S}') and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'accounts.payable.department.ct2759@very-long-domain-example.test', '+91 98765 43210', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_L}', ${T}, '${CUST}', '${NAME}', '${LONG_PLAN}', 'google', 125, 19500, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true),
             ('${SUB_Q}', ${T}, '${CUST}', '${NAME}', 'CT R2759 Quarterly Plan', 'microsoft', 12, 6500, 12, 'quarterly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL_Q}', ${T}, '${SUB_Q}', public.ist_today() - 353, 4, public.ist_today() - 80,
              public.ist_today() - 80, public.ist_today() + 12, 19500, 18);
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2759-Q', ${T}, '${CUST}', '${NAME}', null, 'pending', 23010, 3510, 0, public.ist_today() - 80, public.ist_today() - 43);
    update public.subscription_billings set invoice_id = 'INV-CT2759-Q' where id = '${BILL_Q}';
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_S}', ${T}, '${CUST}', '${NAME}', 'CT R2759 Sent Plan', 'google', 40, 7670, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2759-S', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB_S}',
              public.ist_today() + 12, 12, public.ist_today() - 1, public.ist_today() + 14, 108607.2, 92040, 18,
              jsonb_build_array(jsonb_build_object('name', 'CT R2759 line', 'qty', 40, 'rate', 2301, 'commitment', 'annual_yearly')));
    update public.subscriptions set renewal_quote_id = 'Q-CT2759-S' where id = '${SUB_S}';
    commit;`);
}

async function openAt(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(page.getByTestId("renewals-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("tr", { hasText: LONG_PLAN }).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
  /* the chips settle once the documents are read (R-2758) */
  await expect(page.getByTestId("renewals-table").getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 60_000 });
}

async function fits(page: Page): Promise<void> {
  const m = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
    const actions = [...table.querySelectorAll("tbody tr td:last-child")].map((td) => td.getBoundingClientRect().right);
    return {
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
      tableScroll: table.scrollWidth, tableBox: table.clientWidth,
      maxRight: Math.max(...actions),
      /* code-review: no cell may spill into its neighbour (phone, amount, chip, button) */
      overflowing: [...table.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => (td as HTMLElement).innerText.slice(0, 40)),
    };
  });
  expect(m.scroll, "page has no horizontal scroll").toBeLessThanOrEqual(m.inner);
  expect(m.tableScroll, "the table is not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
  expect(m.maxRight, "Action column inside the viewport").toBeLessThanOrEqual(m.inner);
  expect(m.overflowing, "cells spilling into the next column").toEqual([]);
}

async function rowsShort(page: Page): Promise<void> {
  for (const plan of [LONG_PLAN, "CT R2759 Quarterly Plan", "CT R2759 Sent Plan"]) {
    const r = await page.locator("tr", { hasText: plan }).filter({ visible: true }).evaluate((tr) => ({
      h: tr.getBoundingClientRect().height,
      cells: [...tr.querySelectorAll("td")].map((td) => Math.round(([...td.children] as HTMLElement[]).reduce((m, c) => Math.max(m, c.getBoundingClientRect().height), 0)) + ":" + (td as HTMLElement).innerText.replace(/s+/g, " ").slice(0, 30)),
    }));
    expect(r.h, `${plan} row height — cells ${r.cells.join(" | ")}`).toBeLessThanOrEqual(76);
  }
}

test.describe("R-2759 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: at 1280×800 (sidebar open) the TABLE shows, no horizontal scroll, Action on screen, short rows", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 800);
    await fits(page);
    await rowsShort(page);
    /* R-2764: a 1280 laptop has a 1264–1276px inner width — the Action column ("Record payment" + ⋯) fits there too */
    await openAt(page, 1276, 800);
    await fits(page);
    await page.context().close();
  });

  test("Step 2: at 1568×900 the same — no horizontal scroll, Action on screen", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1568, 900);
    await fits(page);
    await rowsShort(page);
    await page.context().close();
  });

  test("Step 3: the long name / plan truncate with the full text as tooltip; the Last invoice cell says 'Overdue 43d · ₹23,010' uncut", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 800);
    const row = page.locator("tr", { hasText: "CT R2759 Quarterly Plan" }).filter({ visible: true });
    /* the full name, then the owner / follow-up facts the row no longer shows */
    /* R-2767: "No owner yet" is never on the row any more (drawer only) — the tooltip is the full name */
    await expect(row.getByRole("link", { name: NAME })).toHaveAttribute("title", new RegExp(`^${NAME}(?!.*No owner)`));
    const status = row.getByTestId("renewal-last-invoice-status");
    await expect(status).toHaveText("Overdue 43d · ₹23,010");
    const cut = await status.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut, "invoice state is never cut").toBe(false);
    const product = page.locator("tr", { hasText: LONG_PLAN }).filter({ visible: true }).locator('[data-cell="product"] p').first();
    await expect(product).toHaveAttribute("title", new RegExp(LONG_PLAN));
    await page.context().close();
  });
});
