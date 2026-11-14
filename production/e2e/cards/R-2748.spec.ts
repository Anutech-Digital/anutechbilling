/**
 * Card test — R-2748 "Renewals row: last TWO invoices + the quote each came from, each with payment
 * status and period" (Pardeep, 13 Nov 2026: "renewal page par last two invoices and related quotes
 * with payment status show hone chahiye").
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2748`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2748 Renewals Pvt Ltd", every plan's renewal date 5 days ago (Overdue tab):
 *   · A "CT R2748 Two Invoices Plan" — three linked invoices:
 *       INV-CT2748-0 (add-seats quote Q-CT2748-0, 400 days ago, paid)  → too old, NOT shown;
 *       INV-CT2748-1 (original sale Q-CT2748-1, ₹14,160, paid)          → second line "Paid";
 *       INV-CT2748-2 (renewal quote Q-CT2748-2, ₹40,000, ₹6,768 in, due 10 days ago)
 *                                                                      → first line "Overdue 10d · ₹33,232 due";
 *   · B "CT R2748 Cancelled Plan" — an older paid invoice and a NEWER void one → "Cancelled" (grey) first, "Paid" below.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2748000-0000-4000-8000-000000000001";
const SUB_A = "c2748000-0000-4000-8000-000000000021";
const SUB_B = "c2748000-0000-4000-8000-000000000022";
const SUBS = [SUB_A, SUB_B];
const NAME = "CT R2748 Renewals Pvt Ltd";
const QUOTES = ["Q-CT2748-0", "Q-CT2748-1", "Q-CT2748-2", "Q-CT2748-B1", "Q-CT2748-B2"];
const INVOICES = ["INV-CT2748-0", "INV-CT2748-1", "INV-CT2748-2", "INV-CT2748-B1", "INV-CT2748-B2"];
const db = () => localDb("R-2748");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2748", {
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
      values ('${CUST}', ${T}, '${NAME}', 'ct2748@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', 'CT R2748 Two Invoices Plan', 'google', 10, 1000, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', 'CT R2748 Cancelled Plan', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, created_at, amount, subtotal, tax_rate, line_items,
                               add_seats_subscription_id, renewal_subscription_id)
      values ('Q-CT2748-0', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 401, now() - interval '401 days', 2360, 2000, 18, '[]', '${SUB_A}', null),
             ('Q-CT2748-1', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, now() - interval '371 days', 14160, 12000, 18, '[]', null, null),
             ('Q-CT2748-2', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 41, now() - interval '41 days', 40000, 33898.31, 18, '[]', null, '${SUB_A}'),
             ('Q-CT2748-B1', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, now() - interval '371 days', 2360, 2000, 18, '[]', null, null),
             ('Q-CT2748-B2', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 31, now() - interval '31 days', 2360, 2000, 18, '[]', null, '${SUB_B}');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2748-0', ${T}, '${CUST}', '${NAME}', 'Q-CT2748-0', 'paid', 2360, 360, 2360, public.ist_today() - 400, null),
             ('INV-CT2748-1', ${T}, '${CUST}', '${NAME}', 'Q-CT2748-1', 'paid', 14160, 2160, 14160, public.ist_today() - 369, null),
             ('INV-CT2748-2', ${T}, '${CUST}', '${NAME}', 'Q-CT2748-2', 'pending', 40000, 6101.69, 6768, public.ist_today() - 40, public.ist_today() - 10),
             ('INV-CT2748-B1', ${T}, '${CUST}', '${NAME}', 'Q-CT2748-B1', 'paid', 2360, 360, 2360, public.ist_today() - 369, null),
             ('INV-CT2748-B2', ${T}, '${CUST}', '${NAME}', 'Q-CT2748-B2', 'void', 2360, 360, 0, public.ist_today() - 30, null);
    update public.quotes set invoice_id = replace(id, 'Q-', 'INV-') where id in (${inList(QUOTES)}) and tenant_id = ${T};
    update public.subscriptions set quote_id = 'Q-CT2748-1', renewal_quote_id = 'Q-CT2748-2' where id = '${SUB_A}';
    update public.subscriptions set quote_id = 'Q-CT2748-B1' where id = '${SUB_B}';
    commit;`);
}

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

/** Every line of the docs block inside its table cell, none cut (no ellipsis, nothing hidden), page not wider than the window. */
async function fitsUncut(docs: Locator) {
  return docs.evaluate((el) => {
    const cell = el.closest("td")!.getBoundingClientRect();
    const ps = [...el.querySelectorAll("p")];
    return {
      lines: ps.length > 0,
      insideCell: ps.every((p) => p.getBoundingClientRect().right <= cell.right + 0.5),
      noEllipsis: ps.every((p) => getComputedStyle(p).textOverflow !== "ellipsis"),
      nothingHidden: ps.every((p) => p.scrollWidth <= p.clientWidth + 1),
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
}

test.describe("R-2748 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  for (const width of [1568, 1280]) {
    test(`Step 2${width === 1568 ? "" : "b"}: at ${width}px a row shows its last TWO invoices, newest first, each with total, state and its quote — nothing cut`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await page.setViewportSize({ width, height: 900 });
      const r = await rowOf(page, "CT R2748 Two Invoices Plan");
      const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
      const lines = docs.locator("[data-doc-line='invoice']");
      await expect(lines).toHaveCount(2, { timeout: 60_000 });
      await expect(lines.nth(0)).toHaveAttribute("data-invoice-id", "INV-CT2748-2");
      await expect(lines.nth(1)).toHaveAttribute("data-invoice-id", "INV-CT2748-1");
      await expect(docs.locator("[data-invoice-id='INV-CT2748-0']")).toHaveCount(0);   // only the last two

      const newest = lines.nth(0);
      await expect(newest.getByTestId("renewal-invoice-total")).toHaveText("₹40,000");
      const overdue = newest.getByTestId("renewal-last-invoice-status");
      await expect(overdue).toHaveText("Overdue 10d · ₹33,232 due");
      await expect(overdue).toHaveClass(/text-rose-600/);
      await expect(newest.getByTestId("renewal-invoice-quote")).toHaveText(/from Q-CT2748-2 · Accepted$/);

      const older = lines.nth(1);
      await expect(older.getByTestId("renewal-invoice-total")).toHaveText("₹14,160");
      await expect(older.getByTestId("renewal-last-invoice-status")).toHaveText("Paid");
      await expect(older.getByTestId("renewal-invoice-quote")).toHaveText(/from Q-CT2748-1 · Accepted$/);

      /* one fact one place: the renewal quote is the newest invoice's own quote — not repeated above it
         (wait for the links first: the row paints before the role's permissions turn the numbers into links) */
      await expect(await onlyOne(newest.getByRole("link", { name: "INV-CT2748-2" }), "invoice link")).toBeVisible({ timeout: 60_000 });
      await expect(docs.getByRole("link", { name: "Q-CT2748-2" })).toHaveCount(1);
      await expect(docs.getByText(/^Quote /)).toHaveCount(0);
      expect(await fitsUncut(docs)).toEqual({ lines: true, insideCell: true, noEllipsis: true, nothingHidden: true, pageFits: true });
    });
  }

  test("Step 2c: a cancelled newest invoice is grey 'Cancelled', the paid one before it still shows", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2748 Cancelled Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    const lines = docs.locator("[data-doc-line='invoice']");
    await expect(lines).toHaveCount(2, { timeout: 60_000 });
    const cancelled = lines.nth(0).getByTestId("renewal-last-invoice-status");
    await expect(lines.nth(0)).toHaveAttribute("data-invoice-id", "INV-CT2748-B2");
    await expect(cancelled).toHaveText("Cancelled");
    await expect(cancelled).toHaveClass(/text-ink-3/);
    await expect(lines.nth(1).getByTestId("renewal-last-invoice-status")).toHaveText("Paid");
  });

  test("Step 3: the invoice and quote numbers open that invoice / quote", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2748 Two Invoices Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    const invLink = await onlyOne(docs.getByRole("link", { name: "INV-CT2748-2" }), "invoice link");
    await expect(invLink).toHaveAttribute("href", "/invoices/INV-CT2748-2", { timeout: 60_000 });
    await expect(await onlyOne(docs.getByRole("link", { name: "Q-CT2748-1" }), "quote link")).toHaveAttribute("href", "/quotes/Q-CT2748-1");
    await invLink.click();
    await expect(page).toHaveURL(/\/invoices\/INV-CT2748-2$/, { timeout: 120_000 });
  });
});
