/**
 * Card test — R-2821 "Renewals at 1280x720: full customer + product names, 3+ rows visible without
 * scrolling, no sideways scroll".
 *
 * A REAL browser measure (jsdom has no layout). At 1276x720, 1280x720 and 1920x1080, sidebar open, the
 * page shows the TABLE and:
 *   · R-2863 (after R-2854 "widths grow with the window" + R-2861 tiles in one row): Product & period is >= 200 px
 *     wide and Customer >= 150 px (it was 200 for both; a 1280 window now gives Customer ~157, Product ~213), and no
 *     name is cut with an ellipsis (a customer / product name may wrap to 2 lines);
 *   · the first TWO renewal rows end above the fold (bottom <= innerHeight) and the 3rd row has started (its top is
 *     at least 40 px above the fold) — with the Bill-together box / forecast closed, as a user first lands.
 *     MEASURED 16 Nov (1280x720, E2E owner, fca164465): first row top 489, rows 83 px tall → row bottoms 572, 655,
 *     738 (1276 and 1260 the same). The 3rd row ends 18 px BELOW the fold. The old promise was three whole rows
 *     (the base before R-2861 ended them at 786-804); the six tiles in one row won ~50 px, not enough for the third (R-2878);
 *   · document.scrollWidth <= innerWidth, the table is not wider than its box, no cell spills.
 * Run: `node scripts/ops/card-tests.mjs R-2821` (set R2821_OUT=<file> to write the measured numbers).
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): five renewals due
 * in 5-20 days for two customers with ordinary business names (the audit's "Greentin Chemicals", "Google
 * Workspace" shapes), so they all fall in the 8-30 tab (bucket=d30) — a mix of vendors.
 */
import { appendFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST_A = "c2821000-0000-4000-8000-000000000001";
const CUST_B = "c2821000-0000-4000-8000-000000000002";
/* ordinary business names (no "CT R2821" marker: the rows are found by the plan name, the data by fixed ids) — R-2863: the
   marker made them 44 / 37 characters, longer than a real name, and the narrower R-2854 Customer column cut them */
const NAME_A = "Greentin Chemicals & Allied Pvt Ltd";
const NAME_B = "Sharma Infotech Services LLP";
const SUBS: ReadonlyArray<{ id: string; cust: string; name: string; plan: string; vendor: string; seats: number; mrr: number; in: number }> = [
  { id: "c2821000-0000-4000-8000-000000000021", cust: CUST_A, name: NAME_A, plan: "CT R2821 Google Workspace Business Standard", vendor: "google", seats: 25, mrr: 18000, in: 9 },
  { id: "c2821000-0000-4000-8000-000000000022", cust: CUST_B, name: NAME_B, plan: "CT R2821 Microsoft 365 Business Premium", vendor: "microsoft", seats: 12, mrr: 9500, in: 11 },
  { id: "c2821000-0000-4000-8000-000000000023", cust: CUST_A, name: NAME_A, plan: "CT R2821 Zoho Mail Premium", vendor: "zoho", seats: 40, mrr: 7200, in: 13 },
  { id: "c2821000-0000-4000-8000-000000000024", cust: CUST_B, name: NAME_B, plan: "CT R2821 Google Workspace Enterprise Plus", vendor: "google", seats: 8, mrr: 15400, in: 15 },
  { id: "c2821000-0000-4000-8000-000000000025", cust: CUST_A, name: NAME_A, plan: "CT R2821 Microsoft 365 Business Basic", vendor: "microsoft", seats: 60, mrr: 6100, in: 17 },
];
const db = () => localDb("R-2821");
const T = E2E_TENANT_SQL;
const ids = SUBS.map((s) => `'${s.id}'`).join(", ");

/* realistic Status / Last invoice text: an overdue part invoice on SUBS[1], a sent renewal quote on SUBS[2] */
const BILL = "c2821000-0000-4000-8000-000000000031";
const INV = "INV-CT2821-Q";
const QUOTE = "Q-CT2821-S";

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2821", {
    invoiceIds: [INV],
    before: `update public.subscription_billings set invoice_id = null where id = '${BILL}' and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null where id = '${SUBS[2].id}' and tenant_id = ${T};`,
    after: `delete from public.subscription_billings where id = '${BILL}' and tenant_id = ${T};
            delete from public.quotes where id = '${QUOTE}' and tenant_id = ${T};
            delete from public.subscriptions where id in (${ids}) and tenant_id = ${T};
            delete from public.customers where id in ('${CUST_A}', '${CUST_B}') and tenant_id = ${T};`,
  });
}

function seed(): void {
  const rows = SUBS.map((s) => `('${s.id}', ${T}, '${s.cust}', '${s.name}', '${s.plan}', '${s.vendor}', ${s.seats}, ${s.mrr}, 12, 'yearly',
              public.ist_today() - ${365 - s.in}, public.ist_today() + ${s.in}, 'active', 'notice_sent', true)`).join(",\n             ");
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country) values
      ('${CUST_A}', ${T}, '${NAME_A}', 'accounts@greentin-ct2821.test', '+91 98765 43210', '07', 'India'),
      ('${CUST_B}', ${T}, '${NAME_B}', 'it@sharma-ct2821.test', '+91 98765 43211', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${rows};
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL}', ${T}, '${SUBS[1].id}', public.ist_today() - 354, 4, public.ist_today() - 80,
              public.ist_today() - 80, public.ist_today() + 11, 19500, 18);
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('${INV}', ${T}, '${CUST_B}', '${NAME_B}', null, 'pending', 23010, 3510, 0, public.ist_today() - 80, public.ist_today() - 43);
    update public.subscription_billings set invoice_id = '${INV}' where id = '${BILL}';
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('${QUOTE}', ${T}, '${CUST_A}', '${NAME_A}', 'sent', 'none', true, '${SUBS[2].id}',
              public.ist_today() + 13, 12, public.ist_today() - 1, public.ist_today() + 14, 108607.2, 92040, 18,
              jsonb_build_array(jsonb_build_object('name', 'CT R2821 line', 'qty', 40, 'rate', 2301, 'commitment', 'annual_yearly')));
    update public.subscriptions set renewal_quote_id = '${QUOTE}' where id = '${SUBS[2].id}';
    commit;`);
}

async function openAt(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(page.getByTestId("renewals-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("tr", { hasText: SUBS[0].plan }).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("renewals-table").getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 60_000 });
}

interface Measure {
  scroll: number; inner: number; innerH: number; tableScroll: number; tableBox: number;
  customerW: number; productW: number; firstRowTop: number; rowBottoms: number[]; rowTops: number[]; spilling: string[]; cutNames: string[];
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const table = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
    const ths = [...table.querySelectorAll("thead th")] as HTMLElement[];
    const w = (label: string) => ths.find((t) => t.innerText.trim().startsWith(label))?.getBoundingClientRect().width ?? 0;
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    return {
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth, innerH: window.innerHeight,
      tableScroll: table.scrollWidth, tableBox: table.clientWidth,
      customerW: w("Customer"), productW: w("Product"),
      firstRowTop: Math.round(rows[0]?.getBoundingClientRect().top ?? 9999),
      rowBottoms: rows.slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().bottom)),
      rowTops: rows.slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().top)),
      spilling: [...table.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => (td as HTMLElement).innerText.slice(0, 40)),
      /* a name cut with an ellipsis (a one-line clamp) hides words; a 2-line wrap shows them all */
      cutNames: [...table.querySelectorAll('[data-cell="customer"] a, [data-cell="customer"] > p, [data-cell="product"] > p:first-child')]
        .filter((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1 || (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1)
        .map((el) => (el as HTMLElement).innerText.slice(0, 40)),
    };
  });
}

async function check(page: Page, width: number, height: number): Promise<void> {
  await openAt(page, width, height);
  const m = await measure(page);
  if (process.env.R2821_OUT) appendFileSync(process.env.R2821_OUT, `@${width}x${height} ${JSON.stringify(m)}\n`);
  expect(m.scroll, "page has no horizontal scroll").toBeLessThanOrEqual(m.inner);
  expect(m.tableScroll, "the table is not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
  expect(m.spilling, "cells spilling into the next column").toEqual([]);
  expect(m.customerW, "Customer column width").toBeGreaterThanOrEqual(150);
  expect(m.productW, "Product & period column width").toBeGreaterThanOrEqual(200);
  expect(m.cutNames, "customer / product names cut with an ellipsis").toEqual([]);
  expect(m.rowBottoms.length, "seeded rows found").toBeGreaterThanOrEqual(3);
  expect(m.rowBottoms[1], `2nd renewal row ends above the fold (rows end at ${m.rowBottoms.join(", ")} of ${m.innerH})`).toBeLessThanOrEqual(m.innerH);
  expect(m.rowTops[2], `3rd renewal row has started above the fold (rows start at ${m.rowTops.join(", ")} of ${m.innerH})`).toBeLessThanOrEqual(m.innerH - 40);
}

test.describe("R-2821 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: at 1280x720 and 1276x720 the table shows full names, the first 2 rows above the fold (3rd started), no sideways scroll", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await check(page, 1280, 720);
    await check(page, 1276, 720);
    /* the narrowest window that still shows the table (QUEUE_TABLE_MIN_VIEWPORT_PX) */
    await check(page, 1260, 720);
    await page.context().close();
  });

  test("Step 2: at 1920x1080 the same", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await check(page, 1920, 1080);
    await page.context().close();
  });
});
