/**
 * Card test — R-2840 (renewals history audit H5) "Table row shows last payment": the desktop table's
 * "Last bill" column (was "Last invoice") has a 3rd line — "Paid ₹47,200 · 2 Oct" (mode + receipt in
 * the tooltip), a USD invoice's payment in dollars, "Paid on invoice, no receipt" for a settled invoice
 * with no receipt (R-2752 — never "never paid" next to Paid), "No payment yet" when nothing came in.
 * A REAL browser check at 1280×720 and 1276×720: no horizontal scroll, Action on screen, ≥3 rows above the fold.
 * Run: `node scripts/ops/card-tests.mjs R-2840`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer,
 * four subscriptions renewing in 12 days (tab 8–30):
 *   · A "CT R2840 Paid Plan"    — invoice INV-CT2840-A paid by UPI ₹47,200 on 2 Oct, receipt RV-CT2840-A;
 *   · B "CT R2840 USD Plan"     — USD invoice INV-CT2840-B (fx 80) paid ₹96,000 = $1,200 on 2 Oct;
 *   · C "CT R2840 Settled Plan" — invoice INV-CT2840-C Paid, no payment row (settled another way);
 *   · D "CT R2840 Nothing Plan" — no quote, no invoice, no payment.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2840000-0000-4000-8000-000000000001";
const SUB = { A: "c2840000-0000-4000-8000-000000000021", B: "c2840000-0000-4000-8000-000000000022", C: "c2840000-0000-4000-8000-000000000023", D: "c2840000-0000-4000-8000-000000000024" };
const PAY = { A: "c2840000-0000-4000-8000-000000000041", B: "c2840000-0000-4000-8000-000000000042" };
const QUOTES = ["Q-CT2840-A", "Q-CT2840-B", "Q-CT2840-C"];
const INVOICES = ["INV-CT2840-A", "INV-CT2840-B", "INV-CT2840-C"];
const NAME = "CT R2840 Last Bill Customer";
const PLAN = { A: "CT R2840 Paid Plan", B: "CT R2840 USD Plan", C: "CT R2840 Settled Plan", D: "CT R2840 Nothing Plan" };
const db = () => localDb("R-2840");
const T = E2E_TENANT_SQL;
const ids = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2840", {
    invoiceIds: INVOICES,
    quoteIds: QUOTES,
    before: `delete from public.payments where id in (${ids(Object.values(PAY))}) and tenant_id = ${T};
             update public.subscriptions set quote_id = null where id in (${ids(Object.values(SUB))}) and tenant_id = ${T};`,
    after: `delete from public.subscriptions where id in (${ids(Object.values(SUB))}) and tenant_id = ${T};
            delete from public.quotes where id in (${ids(QUOTES)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const quote = (id: string, amount: number, subtotal: number, currency: string, fx: string) => // fx = quotes.exchange_rate
    `('${id}', ${T}, '${CUST}', '${NAME}', 'accepted', 'received', ${amount}, ${subtotal}, 18, '${currency}', ${fx}, public.ist_today() - 50,
      jsonb_build_array(jsonb_build_object('name', 'CT R2840 line', 'qty', 1, 'rate', ${subtotal}, 'commitment', 'annual_yearly')))`;
  const sub = (id: string, plan: string, quoteId: string | null) =>
    `('${id}', ${T}, '${CUST}', '${NAME}', '${plan}', 'google', 10, 3333, 12, 'yearly', ${quoteId ? `'${quoteId}'` : "null"},
      public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true)`;
  const invoice = (id: string, quoteId: string, amount: number, tax: number, currency: string, fx: string) =>
    `('${id}', ${T}, '${CUST}', '${NAME}', '${quoteId}', 'paid', ${amount}, ${tax}, ${amount}, '${currency}', ${fx}, public.ist_today() - 48, public.ist_today() - 40)`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2840@example.test', '+91 98765 28400', '07', 'India');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, currency, exchange_rate, created_date, line_items)
      values ${quote("Q-CT2840-A", 47200, 40000, "INR", "1")}, ${quote("Q-CT2840-B", 96000, 81356, "USD", "80")}, ${quote("Q-CT2840-C", 23600, 20000, "INR", "1")};
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle, quote_id,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${sub(SUB.A, PLAN.A, "Q-CT2840-A")}, ${sub(SUB.B, PLAN.B, "Q-CT2840-B")}, ${sub(SUB.C, PLAN.C, "Q-CT2840-C")}, ${sub(SUB.D, PLAN.D, null)};
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, currency, fx_rate, invoice_date, due_date)
      values ${invoice("INV-CT2840-A", "Q-CT2840-A", 47200, 7200, "INR", "1")}, ${invoice("INV-CT2840-B", "Q-CT2840-B", 96000, 14644, "USD", "80")},
             ${invoice("INV-CT2840-C", "Q-CT2840-C", 23600, 3600, "INR", "1")};
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, receipt_voucher_no)
      values ('${PAY.A}', ${T}, 'Q-CT2840-A', '${CUST}', 47200, 'upi', 'R2840-CARD-A', 'received', '2026-10-02 11:00:00+05:30', 'RV-CT2840-A'),
             ('${PAY.B}', ${T}, 'Q-CT2840-B', '${CUST}', 96000, 'bank_transfer', 'R2840-CARD-B', 'received', '2026-10-02 11:00:00+05:30', null);
    commit;`);
}

/** "2 Oct" this year, "2 Oct 26" from next year on (the row adds the year when it is not this year). */
function oct2(): string {
  const istYear = new Date(Date.now() + 330 * 60_000).getUTCFullYear();
  return istYear === 2026 ? "2 Oct" : "2 Oct 26";
}

const row = (page: Page, plan: string) => page.locator("tr", { hasText: plan }).filter({ visible: true });

async function openAt(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  /* a busy laptop's local Supabase sometimes drops a read (CORS preflight timeout → "couldn't load");
     the page says so honestly — reload (up to 3 tries) rather than judge a failed read */
  for (let attempt = 1; ; attempt++) {
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    await expect(page.getByTestId("renewals-table")).toBeVisible({ timeout: 60_000 });
    await expect(row(page, PLAN.A)).toHaveCount(1, { timeout: 60_000 });
    /* the Last bill line settles once Last paid + Last docs are read */
    const lines = page.getByTestId("renewals-table").getByTestId("renewal-row-last-paid");
    await expect(lines.filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    /* the Status chips settle once the stages are read (R-2758) — their loading bar is not a real cell to measure */
    await expect(page.getByTestId("renewals-table").getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 90_000 });
    const failed = await lines.filter({ hasText: /couldn.t load/ }).count();
    if (!failed) return;
    if (attempt >= 3) throw new Error(`Last payment read failed ${attempt}x on this server (local Supabase load)`);
  }
}

async function fits(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
    /* "above the fold" once the worker reaches the list: the header row scrolled to the top of the window
       (tiles + filters above the table already take ~650px of a 720px window before this card) */
    const tableTopOnLoad = Math.round(table.getBoundingClientRect().top + window.scrollY);
    window.scrollTo(0, tableTopOnLoad);
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    const actions = rows.map((tr) => (tr.lastElementChild as HTMLElement).getBoundingClientRect().right);
    return {
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth, innerH: window.innerHeight,
      tableScroll: table.scrollWidth, tableBox: table.clientWidth,
      maxRight: Math.max(...actions),
      tableTopOnLoad,
      rowsAboveFold: rows.filter((tr) => tr.getBoundingClientRect().top >= 0 && tr.getBoundingClientRect().bottom <= window.innerHeight).length,
      rowHeights: rows.slice(0, 6).map((tr) => Math.round(tr.getBoundingClientRect().height)),
      /* which cell sets each row's height (content height, not the td) */
      tallest: rows.slice(0, 6).map((tr) => [...tr.querySelectorAll("td")].map((td, i) => [i, Math.round([...td.children].reduce((h, c) => h + c.getBoundingClientRect().height, 0))] as const).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([i, h]) => `c${i}:${h}`).join(",")),
      overflowing: [...table.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => `c${(td as HTMLTableCellElement).cellIndex}:${(td as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 60)}`),
    };
  });
  test.info().annotations.push({ type: "measured", description: `${label}: inner ${m.inner}px, page scrollWidth ${m.scroll}, table ${m.tableScroll}/${m.tableBox}, Action right edge ${Math.round(m.maxRight)}, table starts at ${m.tableTopOnLoad}px, rows above the fold with the table at the top ${m.rowsAboveFold}, row heights ${m.rowHeights.join("/")} (tallest cells ${m.tallest.join(" | ")}); spilling: ${m.overflowing.join(" // ") || "none"}` });
  expect(m.scroll, "page has no horizontal scroll").toBeLessThanOrEqual(m.inner);
  expect(m.tableScroll, "the table is not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
  expect(m.maxRight, "Action column inside the viewport").toBeLessThanOrEqual(m.inner);
  expect(m.overflowing, "cells spilling into the next column").toEqual([]);
  expect(m.rowsAboveFold, "rows fully above the fold").toBeGreaterThanOrEqual(3);
}

test.describe("R-2840 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 420_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals → 8–30 days at 1280×720: the column is 'Last bill' and each row shows its last payment", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 720);
    await expect(page.getByTestId("renewals-table").getByRole("columnheader", { name: "Last bill" })).toBeVisible();
    await expect(page.getByTestId("renewals-table").getByRole("columnheader", { name: "Last invoice" })).toHaveCount(0);
    const a = row(page, PLAN.A).getByTestId("renewal-row-last-paid");
    await expect(a).toHaveText(`Paid ₹47,200 · ${oct2()}`, { timeout: 60_000 });
    await expect(a).toHaveAttribute("title", /UPI · receipt RV-CT2840-A · for INV-CT2840-A/);
    await expect(row(page, PLAN.B).getByTestId("renewal-row-last-paid")).toHaveText(`Paid $1,200 · ${oct2()}`);
    await expect(row(page, PLAN.C).getByTestId("renewal-row-last-paid")).toHaveText("Paid on invoice, no receipt");
    await expect(row(page, PLAN.D).getByTestId("renewal-row-last-paid")).toHaveText("No payment yet");
    /* R-2752: never "never paid" anywhere in the table */
    await expect(page.getByTestId("renewals-table").getByText(/never paid/i)).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: at 1280×720 and 1276×720 — no horizontal scroll, Action on screen, at least 3 rows above the fold", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 720);
    await fits(page, "1280x720");
    await openAt(page, 1276, 720);
    await fits(page, "1276x720");
    await page.context().close();
  });
});
