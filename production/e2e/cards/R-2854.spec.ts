/**
 * Card test — R-2854 "Renewals table: rows 120–160px tall — Status / Last bill squeezed to 92px while Customer /
 * Product get 518px; money breaks mid-word, numbers cut" (+ Pardeep 16 Nov: this renewal's quote line under
 * Product & period on every row; Last bill = invoice + payment only).
 *
 * A REAL browser measure (jsdom has no layout), one test per howToCheck step, on the LOCAL app (E2E Test Co)
 * through the Local test login. Run: `node scripts/ops/card-tests.mjs R-2854` (R2854_OUT=<file> writes the
 * measured numbers; R2854_KEEP=1 leaves the rows in place to look at them by hand).
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): three customers, six
 * Google subscriptions whose renewal date was 5 days ago (Overdue tab, on hold at Google):
 *   · "CT R2854 Supreme Plan" — renewal quote Q-T854-27-0845 sent on 3 Oct, ₹3,823;
 *   · "CT R2854 Itbuzz Plan"  — ₹63,855 a month, no renewal quote;
 *   · "CT R2854 Aroka Plan"   — invoice INV-T854-27-0046 paid by UPI ₹47,200 on 2 Oct (receipt RV-CT2854-A);
 *   · three more plain rows, so six of this card's own rows are in the table.
 */
import { appendFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = { S: "c2854000-0000-4000-8000-000000000001", I: "c2854000-0000-4000-8000-000000000002", A: "c2854000-0000-4000-8000-000000000003" };
const NAME = { S: "CT R2854 Supreme Media Pvt Ltd", I: "CT R2854 Itbuzz Technologies", A: "CT R2854 Aroka Exports" };
const SUB = {
  S: "c2854000-0000-4000-8000-000000000021", I: "c2854000-0000-4000-8000-000000000022", A: "c2854000-0000-4000-8000-000000000023",
  X1: "c2854000-0000-4000-8000-000000000024", X2: "c2854000-0000-4000-8000-000000000025", X3: "c2854000-0000-4000-8000-000000000026",
};
const PLAN = { S: "CT R2854 Supreme Plan", I: "CT R2854 Itbuzz Plan", A: "CT R2854 Aroka Plan", X1: "CT R2854 Extra One", X2: "CT R2854 Extra Two", X3: "CT R2854 Extra Three" };
const PAY = "c2854000-0000-4000-8000-000000000041";
const Q_REN = "Q-T854-27-0845";
const Q_SALE = "Q-T854-26-0046";
const INV = "INV-T854-27-0046";
const db = () => localDb("R-2854");
const T = E2E_TENANT_SQL;
const ids = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2854", {
    invoiceIds: [INV],
    quoteIds: [Q_SALE],
    before: `delete from public.payments where id = '${PAY}' and tenant_id = ${T};
             update public.subscriptions set quote_id = null, renewal_quote_id = null where id in (${ids(Object.values(SUB))}) and tenant_id = ${T};`,
    after: `delete from public.subscriptions where id in (${ids(Object.values(SUB))}) and tenant_id = ${T};
            delete from public.quotes where id in ('${Q_REN}', '${Q_SALE}') and tenant_id = ${T};
            delete from public.customers where id in (${ids(Object.values(CUST))}) and tenant_id = ${T};`,
  });
}

function seed(): void {
  const sub = (id: string, cust: string, name: string, plan: string, mrr: number, term: number, cycle: string, seats: number) =>
    `('${id}', ${T}, '${cust}', '${name}', '${plan}', 'google', ${seats}, ${mrr}, ${term}, '${cycle}',
      public.ist_today() - ${term === 1 ? 35 : 370}, public.ist_today() - 5, 'active', 'notice_sent', true)`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country) values
      ('${CUST.S}', ${T}, '${NAME.S}', 'accounts@supreme-ct2854.test', '+91 98765 28541', '07', 'India'),
      ('${CUST.I}', ${T}, '${NAME.I}', 'it@itbuzz-ct2854.test', '+91 98765 28542', '07', 'India'),
      ('${CUST.A}', ${T}, '${NAME.A}', 'billing@aroka-ct2854.test', '+91 98765 28543', '07', 'India');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, currency, exchange_rate, created_date, line_items)
      values ('${Q_SALE}', ${T}, '${CUST.A}', '${NAME.A}', 'accepted', 'received', 47200, 40000, 18, 'INR', 1, public.ist_today() - 50,
              jsonb_build_array(jsonb_build_object('name', 'CT R2854 line', 'qty', 1, 'rate', 40000, 'commitment', 'annual_yearly')));
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${sub(SUB.S, CUST.S, NAME.S, PLAN.S, 270, 12, "yearly", 3)}, ${sub(SUB.I, CUST.I, NAME.I, PLAN.I, 63855, 1, "monthly", 161)},
             ${sub(SUB.A, CUST.A, NAME.A, PLAN.A, 3333, 12, "yearly", 10)}, ${sub(SUB.X1, CUST.S, NAME.S, PLAN.X1, 500, 12, "yearly", 1)},
             ${sub(SUB.X2, CUST.I, NAME.I, PLAN.X2, 700, 12, "yearly", 4)}, ${sub(SUB.X3, CUST.A, NAME.A, PLAN.X3, 900, 12, "yearly", 6)};
    update public.subscriptions set quote_id = '${Q_SALE}' where id = '${SUB.A}';
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, currency, fx_rate, invoice_date, due_date)
      values ('${INV}', ${T}, '${CUST.A}', '${NAME.A}', '${Q_SALE}', 'paid', 47200, 7200, 47200, 'INR', 1, public.ist_today() - 48, public.ist_today() - 40);
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, receipt_voucher_no)
      values ('${PAY}', ${T}, '${Q_SALE}', '${CUST.A}', 47200, 'upi', 'R2854-CARD-A', 'received', '2026-10-02 11:00:00+05:30', 'RV-CT2854-A');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('${Q_REN}', ${T}, '${CUST.S}', '${NAME.S}', 'sent', 'none', true, '${SUB.S}',
              public.ist_today() - 5, 12, '2026-10-03', public.ist_today() + 14, 3823, 3240, 18,
              jsonb_build_array(jsonb_build_object('name', 'CT R2854 line', 'qty', 3, 'rate', 1080, 'commitment', 'annual_yearly')));
    update public.subscriptions set renewal_quote_id = '${Q_REN}' where id = '${SUB.S}';
    commit;`);
}

/** "3 Oct" this year, "3 Oct 26" from next year on (the row adds the year when it is not this year). */
function day(d: number): string {
  const istYear = new Date(Date.now() + 330 * 60_000).getUTCFullYear();
  return istYear === 2026 ? `${d} Oct` : `${d} Oct 26`;
}

const row = (page: Page, plan: string) => page.locator("tr", { hasText: plan }).filter({ visible: true });

async function openAt(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  /* a busy laptop's local Supabase sometimes drops a read ("couldn't load") — reload (up to 3 tries) rather than judge a failed read */
  for (let attempt = 1; ; attempt++) {
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(row(page, PLAN.S)).toHaveCount(1, { timeout: 90_000 });
    await expect(table.getByTestId("renewal-row-last-paid").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    await expect(table.getByTestId("renewal-row-quote").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 90_000 });
    const failed = await table.getByText(/couldn.t load/).count();
    if (!failed) return;
    if (attempt >= 3) throw new Error(`a row read failed ${attempt}x on this server (local Supabase load)`);
  }
}

interface Measure {
  inner: number; scroll: number; tableScroll: number; tableBox: number; cols: number[]; rowsAboveFold: number;
  mine: { plan: string; h: number }[]; spilling: string[]; clipped: string[]; wordless: number;
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate((plans) => {
    const table = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
    /* "above the fold" once the worker reaches the list: the header row scrolled to the top of the window */
    window.scrollTo(0, Math.round(table.getBoundingClientRect().top + window.scrollY));
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    const inside = (el: Element) => { const td = el.closest("td")!.getBoundingClientRect(); const r = el.getBoundingClientRect(); return r.right <= td.right + 0.5 && r.left >= td.left - 0.5; };
    return {
      inner: window.innerWidth, scroll: document.documentElement.scrollWidth, tableScroll: table.scrollWidth, tableBox: table.clientWidth,
      cols: [...table.querySelectorAll("thead th")].map((th) => Math.round(th.getBoundingClientRect().width)),
      rowsAboveFold: rows.filter((tr) => tr.getBoundingClientRect().top >= 0 && tr.getBoundingClientRect().bottom <= window.innerHeight).length,
      mine: plans.map((plan) => ({ plan, h: Math.round(rows.find((tr) => tr.innerText.includes(plan))?.getBoundingClientRect().height ?? -1) })),
      spilling: [...table.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => `c${(td as HTMLTableCellElement).cellIndex}:${(td as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 50)}`),
      /* a document number or an amount that leaves its cell, is cut, or is on more than one line */
      clipped: [...table.querySelectorAll('[data-testid="renewal-last-invoice-no"], [data-testid="renewal-row-quote"] a, [data-testid="renewal-row-amount"] span')]
        .filter((el) => !inside(el) || el.scrollWidth > el.clientWidth + 1 || el.getClientRects().length > 1)
        .map((el) => (el as HTMLElement).innerText),
      /* a flag with an icon and no words */
      wordless: [...table.querySelectorAll("[data-flag]")].filter((el) => (el.textContent ?? "").trim().length < 4).length,
    };
  }, Object.values(PLAN));
}

function note(label: string, m: Measure): void {
  const text = `${label}: inner ${m.inner}px, page scrollWidth ${m.scroll}, table ${m.tableScroll}/${m.tableBox}, columns ${m.cols.join("/")}, rows above the fold (table at the top) ${m.rowsAboveFold}, this card's row heights ${m.mine.map((r) => r.h).join("/")}; spilling: ${m.spilling.join(" // ") || "none"}; clipped: ${m.clipped.join(" // ") || "none"}`;
  test.info().annotations.push({ type: "measured", description: text });
  if (process.env.R2854_OUT) appendFileSync(process.env.R2854_OUT, `${text}\n`);
}

function fits(m: Measure): void {
  expect(m.scroll, "page has no sideways scroll").toBeLessThanOrEqual(m.inner);
  expect(m.tableScroll, "the table is not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
  expect(m.spilling, "cells spilling into the next column").toEqual([]);
  expect(m.clipped, "document numbers / amounts cut, broken or outside their cell").toEqual([]);
  expect(m.wordless, "flags with no words").toBe(0);
  for (const r of m.mine) expect(r.h, `${r.plan} is in the table`).toBeGreaterThan(0);
}

async function oneLine(el: Locator): Promise<boolean> {
  return el.evaluate((e) => { const lh = parseFloat(getComputedStyle(e).lineHeight) || 20; return e.getBoundingClientRect().height <= lh * 1.5; });
}

test.describe("R-2854 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 480_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON && process.env.R2854_KEEP !== "1") clean(); });

  test("Step 1: Renewals → Overdue on a big screen (1920×889): every row is short (≤ 3 lines, ~76px) and at least 6 rows show", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1920, 889);
    const m = await measure(page);
    note("1920x889", m);
    fits(m);
    for (const r of m.mine) expect(r.h, `${r.plan} row height`).toBeLessThanOrEqual(76);
    expect(m.rowsAboveFold, "rows above the fold").toBeGreaterThanOrEqual(6);
    /* Status and Last bill are no longer 92px; Customer is capped so Product is not half empty */
    expect(m.cols[5]).toBeGreaterThanOrEqual(190);
    expect(m.cols[6]).toBeGreaterThanOrEqual(250);
    expect(m.cols[1]).toBeLessThanOrEqual(321);
    await page.context().close();
  });

  test("Step 2: every row has its quote line under Product & period — a sent quote opens on click, 'No renewal quote yet' where none; Last bill names no quote", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1920, 889);
    const table = page.getByTestId("renewals-table");
    expect(await table.getByTestId("renewal-row-quote").count(), "one quote line per row").toBe(await table.getByTestId("renewal-row").count());
    const sent = await onlyOne(row(page, PLAN.S).getByTestId("renewal-row-quote"), "Supreme's quote line");
    await expect(sent).toHaveText(new RegExp(`^Quote\\s*${Q_REN}\\s*· Sent ${day(3)}\\s*· ₹3,823$`));
    expect(await sent.evaluate((e) => (e.closest("td") as HTMLTableCellElement).cellIndex), "under Product & period").toBe(2);
    for (const plan of [PLAN.I, PLAN.A, PLAN.X1]) await expect(row(page, plan).getByTestId("renewal-row-quote")).toHaveText("No renewal quote yet");
    /* one fact once: no quote in any Last bill cell, no quote total in any Amount cell */
    for (const cell of await table.locator('[data-cell="invoice"]').all()) expect(await cell.innerText()).not.toMatch(/Quote|quote|Q-|PI-/);
    for (const cell of await table.locator('[data-cell="amount"]').all()) expect(await cell.innerText()).not.toMatch(/quote/i);
    /* the number becomes a link once the viewer's permissions are read — wait for what you click (R-2666) */
    const link = sent.getByRole("link", { name: Q_REN });
    await expect(link).toBeVisible({ timeout: 90_000 });
    await link.click();
    /* R-2866: the number opens the quote pop-up over Renewals; its "Open full quote" goes to the quote's page */
    const peek = page.getByRole("dialog", { name: `Quote ${Q_REN}` });
    await expect(peek).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/renewals/);
    await peek.getByRole("link", { name: "Open full quote" }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${Q_REN}`), { timeout: 240_000 });   // a cold dev server compiles the quote page first
    await page.context().close();
  });

  test("Step 3: '₹63,855/mo' is one line; the invoice number is whole; every flag has words; Aroka says 'Paid' once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1920, 889);
    const amount = await onlyOne(row(page, PLAN.I).getByTestId("renewal-row-amount"), "Itbuzz amount");
    await expect(amount).toHaveText("₹63,855/mo");
    expect(await oneLine(amount), "the amount is on one line").toBe(true);
    const aroka = row(page, PLAN.A);
    await expect(aroka.getByTestId("renewal-last-invoice-no")).toHaveText(INV);
    /* the payment line settles once Last paid is read (a busy server shows "…" for a while) */
    await expect(aroka.getByTestId("renewal-row-last-paid")).toHaveText(`Paid ₹47,200 · ${day(2)}`, { timeout: 90_000 });
    const bill = (await aroka.locator('[data-cell="invoice"]').innerText()).replace(/\s+/g, " ");
    expect(bill).toContain(`Paid ₹47,200 · ${day(2)}`);
    expect(bill.match(/Paid/g), bill).toHaveLength(1);
    expect(bill).not.toMatch(/…|\.\.\./);
    /* on hold at Google: the flag reads in words */
    await expect(row(page, PLAN.I).locator('[data-flag="vendorHold"]')).toHaveText("Hold at Google — unpaid");
    for (const flag of await page.getByTestId("renewals-table").locator("[data-flag]").all()) expect((await flag.innerText()).trim().length).toBeGreaterThan(3);
    await page.context().close();
  });

  test("Step 4: a 1280 laptop (1280×720 and 1276×720): no sideways scroll, nothing cut or broken, at least 4 rows show", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    for (const [w, h] of [[1280, 720], [1276, 720]] as const) {
      await openAt(page, w, h);
      const m = await measure(page);
      note(`${w}x${h}`, m);
      fits(m);
      expect(m.rowsAboveFold, `rows above the fold at ${w}`).toBeGreaterThanOrEqual(4);
      /* narrower columns: names and the hold words take two lines — a row stays far under the old 139–200px */
      for (const r of m.mine) expect(r.h, `${r.plan} row height at ${w}`).toBeLessThanOrEqual(96);
      const amount = await onlyOne(row(page, PLAN.I).getByTestId("renewal-row-amount"), "Itbuzz amount");
      expect(await oneLine(amount), `the amount is on one line at ${w}`).toBe(true);
      /* the quote line is ONE line here: the short form "Q-… · Sent 3 Oct" (the total joins from a 1680 window; it is in the tooltip) */
      const quote = await onlyOne(row(page, PLAN.S).getByTestId("renewal-row-quote"), "Supreme quote line");
      expect(await oneLine(quote), `the quote line is one line at ${w}`).toBe(true);
      await expect(quote.getByRole("link", { name: Q_REN })).toBeVisible({ timeout: 90_000 });
      await expect(quote).toContainText(`Sent ${day(3)}`);
      await expect(quote).toHaveAttribute("title", /₹3,823 incl. GST/);
    }
    await page.context().close();
  });
});
