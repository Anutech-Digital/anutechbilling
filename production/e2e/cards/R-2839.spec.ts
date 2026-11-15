/**
 * Card test — R-2839 "Renewals history H4: visible 'History' button on every row".
 *
 * At 1280×720 and 1276 (the table layout): every row's Last bill cell ends in a small "History" button
 * ("+N earlier" is gone); the page has no horizontal scroll and the Action column stays on screen. The
 * FIRST click right after the rows appear opens the row drawer with ?view=history and focus on History's
 * active tab (All). Keyboard: Tab to History + Enter does the same; Esc closes and focus comes back to the
 * button. The product name still opens the same drawer (no view). Below 1260 (cards) the button sits under
 * the last-docs lines and does the same. Run: `node scripts/ops/card-tests.mjs R-2839`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer, one
 * yearly subscription renewing in 12 days; quote Q-CT2839-A → INV-CT2839-A (paid) and a billed part →
 * INV-CT2839-B (part paid) — two invoices, so the old cell said "+1 earlier"; one UPI payment on the quote.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2839000-0000-4000-8000-000000000001";
const SUB = "c2839000-0000-4000-8000-000000000021";
const PAY = "c2839000-0000-4000-8000-000000000041";
const BILL = "c2839000-0000-4000-8000-000000000031";
const NAME = "CT R2839 History Button Traders";
const PLAN = "CT R2839 Workspace Yearly";
const INVOICES = ["INV-CT2839-A", "INV-CT2839-B"];
const db = () => localDb("R-2839");
const T = E2E_TENANT_SQL;

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2839", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id = '${BILL}' and tenant_id = ${T};
             update public.subscriptions set quote_id = null where id = '${SUB}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id = 'Q-CT2839-A' and tenant_id = ${T};`,
    after: `delete from public.quotes where id = 'Q-CT2839-A' and tenant_id = ${T};
            delete from public.subscription_billings where id = '${BILL}' and tenant_id = ${T};
            delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', '${PLAN}', 'qty', 10, 'rate', 1695, 'commitment', 'annual_yearly'))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2839@example.test', '+91 98765 28390', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 10, 1667, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 0, 0);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2839-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'partial', public.ist_today() - 360, 20000, 16949, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2839-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2839-A', 'paid', 10000, 1525, 10000, public.ist_today() - 355, public.ist_today() - 340),
             ('INV-CT2839-B', ${T}, '${CUST}', '${NAME}', null, 'pending', 10000, 1525, 4000, public.ist_today() - 170, public.ist_today() - 155);
    update public.quotes set invoice_id = 'INV-CT2839-A' where id = 'Q-CT2839-A' and tenant_id = ${T};
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
      values ('${BILL}', ${T}, '${SUB}', public.ist_today() - 353, 2, public.ist_today() - 170,
              public.ist_today() - 170, public.ist_today() + 12, 8475, 18, 'INV-CT2839-B');
    update public.subscriptions set quote_id = 'Q-CT2839-A' where id = '${SUB}' and tenant_id = ${T};
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY}', ${T}, 'Q-CT2839-A', '${CUST}', 14000, 'upi', 'CTUTR2839', 'received', now() - interval '160 days', 'Card test R-2839 — local only');
    commit;`);
}

const tableRow = (page: Page) => page.getByTestId("renewals-table").locator("tr", { hasText: PLAN });

/** Open Renewals → 8–30 days and wait only for OUR row to appear — the click comes right after (no settle wait). */
async function openList(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
}

async function expectOnHistory(page: Page): Promise<void> {
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("sub")).toBe(SUB);
  expect(new URL(page.url()).searchParams.get("view")).toBe("history");
  const history = drawer.getByTestId("renewal-drawer-history");
  /* focus is on History's active tab (All) */
  await expect(history.getByRole("tab", { name: /^All/ })).toBeFocused({ timeout: 10_000 });
  /* and History is on screen inside the drawer */
  const box = await history.boundingBox();
  const vh = page.viewportSize()!.height;
  expect(box && box.y >= 0 && box.y < vh, "History section is on screen").toBeTruthy();
}

test.describe("R-2839 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: at 1280×720 the row's Last bill ends in 'History' (no '+N earlier'); the first click right after load opens the drawer on History", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openList(page, 1280, 720);
    const btn = tableRow(page).getByRole("button", { name: /^History/ });
    await expect(btn).toBeVisible({ timeout: 90_000 });
    await expect(btn).toHaveText("History");
    /* first click, no waiting for the rest of the page to settle */
    await btn.click();
    await expectOnHistory(page);
    await expect(tableRow(page).getByTestId("renewal-last-invoice-cell")).not.toContainText("earlier");
  });

  for (const width of [1280, 1276]) {
    test(`Step 2${width === 1280 ? "" : "b"}: at ${width}×720 every row shows History; no horizontal scroll, Action column on screen`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await openList(page, width, 720);
      await expect(tableRow(page)).toHaveCount(1, { timeout: 90_000 });
      const table = page.getByTestId("renewals-table");
      await expect(table.getByTestId("renewal-row-last-paid").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
      await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 90_000 });
      const m = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
        const rows = [...t.querySelectorAll("tbody tr[data-testid=renewal-row]")] as HTMLElement[];
        return {
          scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
          tableScroll: t.scrollWidth, tableBox: t.clientWidth,
          rows: rows.length,
          withHistory: rows.filter((tr) => tr.querySelector("[data-testid=renewal-open-history]")).length,
          maxRight: Math.max(...rows.map((tr) => (tr.lastElementChild as HTMLElement).getBoundingClientRect().right)),
          overflowing: [...t.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => (td as HTMLElement).innerText.slice(0, 40)),
        };
      });
      test.info().annotations.push({ type: "measured", description: `${width}: inner ${m.inner}, page scrollWidth ${m.scroll}, table ${m.tableScroll}/${m.tableBox}, rows ${m.rows}, with History ${m.withHistory}, Action right ${Math.round(m.maxRight)}` });
      expect(m.withHistory, "every row has History").toBe(m.rows);
      expect(m.scroll, "page has no horizontal scroll").toBeLessThanOrEqual(m.inner);
      expect(m.tableScroll, "table not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
      expect(m.maxRight, "Action column inside the window").toBeLessThanOrEqual(m.inner);
      expect(m.overflowing, "cells spilling into the next column").toEqual([]);
    });
  }

  test("Step 3: keyboard — Tab to History, Enter opens it on History; Esc closes and focus is back on the button; the product name still opens the drawer plain", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openList(page, 1280, 720);
    const btn = tableRow(page).getByRole("button", { name: /^History/ });
    await expect(btn).toBeVisible({ timeout: 90_000 });
    await btn.focus();
    await page.keyboard.press("Enter");
    await expectOnHistory(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("renewal-drawer")).toHaveCount(0, { timeout: 10_000 });
    await expect(btn).toBeFocused();
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBeNull();
    /* product name = the same drawer, at the top (no view) */
    await tableRow(page).getByTestId("renewal-open-drawer").click();
    await expect(page.getByTestId("renewal-drawer").getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get("sub")).toBe(SUB);
    expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  });

  test("Step 4: a smaller window (cards, 1100 wide) — History under the last-docs lines opens the drawer on History", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openList(page, 1100, 800);
    const card = page.getByTestId("renewals-cards").locator("li", { hasText: PLAN });
    const btn = card.getByRole("button", { name: /^History/ });
    await expect(btn).toBeVisible({ timeout: 90_000 });
    await btn.click();
    await expectOnHistory(page);
  });
});
